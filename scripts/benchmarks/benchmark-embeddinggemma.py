#!/usr/bin/env python3
"""Offline Scoutpost retrieval and semantic-dedup benchmark for EmbeddingGemma.

The script consumes a deliberately small, human-labelled municipal-news corpus.
It reports retrieval quality, semantic dedup classification, threshold
sensitivity, and local CPU runtime for every supported MRL dimension.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import statistics
import time
from pathlib import Path
from typing import Any

import numpy as np
import onnxruntime as ort
import psutil
from transformers import AutoTokenizer


SUPPORTED_DIMENSIONS = (768, 512, 256, 128)
SCOUTPOST_THRESHOLDS = (0.75, 0.80, 0.82, 0.85, 0.88, 0.93)
EXPECTED_REVISION = "5090578d9565bb06545b4552f76e6bc2c93e4a66"
EXPECTED_MODEL_FILE = "onnx/model_quantized.onnx"
EXPECTED_MODEL_SHA256 = "172efde319fe1542dc41f31be6154910b05b78f7a861c265c4600eec906bd6d8"
EXPECTED_DATA_SHA256 = "705626e28e4c23c82ade34566b4197d97f534c12275fa406dfb71e9937d388c0"
EXPECTED_FP32_MODEL_SHA256 = (
    "ea91fd315a7c152d427d231746f0f811a1ac93beaba656abfdf2b24e091265e4"
)
EXPECTED_FP32_DATA_SHA256 = (
    "ef835ae565d8695236652475903078e8ed794c7c35faf1164d78ec3238e8a88d"
)
# Pinned FP32 graph measured with the same RETRIEVAL_DOCUMENT prefix used by
# production dedup. This is deliberately not the sentence-similarity baseline.
FULL_PRECISION_BASELINE = {"roc_auc": 0.795556, "best_f1": 0.83871}
QUALITY_TOLERANCE = 0.02


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument(
        "--model-file",
        default="onnx/model_quantized.onnx",
        help="Model path relative to --model-dir",
    )
    parser.add_argument("--precision", default="int8")
    parser.add_argument(
        "--reference-full-precision",
        action="store_true",
        help="Measure the pinned FP32 graph under the same production contract",
    )
    parser.add_argument(
        "--fixtures",
        type=Path,
        default=Path(__file__).with_name("embedding-quality-fixtures.json"),
    )
    parser.add_argument("--output", type=Path)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument(
        "--distractor-dir",
        type=Path,
        default=Path(__file__).parent / "baselines" / "firecrawl-2026-07",
        help="Markdown directory chunked into realistic unlabelled distractors",
    )
    return parser.parse_args()


def normalize(vectors: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    return vectors / np.maximum(norms, np.finfo(vectors.dtype).eps)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def artifact_identity(model_dir: Path, model_file: str) -> dict[str, Any]:
    model_path = model_dir / model_file
    data_path = model_path.with_name(f"{model_path.name}_data")
    metadata_path = (
        model_dir / ".cache" / "huggingface" / "download" / f"{model_file}.metadata"
    )
    revision = metadata_path.read_text().splitlines()[0] if metadata_path.exists() else None
    return {
        "revision": revision,
        "model_sha256": sha256(model_path),
        "data_sha256": sha256(data_path),
    }


def hard_negative_conflict(pair: dict[str, Any]) -> bool:
    guard = pair.get("guard")
    if guard == "numeric":
        pattern = r"[0-9]+(?:[.,][0-9]+)?%?"
        return sorted(set(re.findall(pattern, pair["left"].lower()))) != sorted(
            set(re.findall(pattern, pair["right"].lower()))
        )
    if guard == "date":
        left = np.datetime64(pair["left_date"])
        right = np.datetime64(pair["right_date"])
        return abs(int((left - right).astype("timedelta64[D]").astype(int))) > 1
    if guard == "outcome":
        return pair.get("left_outcome") != pair.get("right_outcome")
    if guard == "entity":
        return set(pair.get("left_entities", [])).isdisjoint(
            pair.get("right_entities", [])
        )
    return False


class LocalEmbedder:
    def __init__(self, model_dir: Path, model_file: str, batch_size: int) -> None:
        self.tokenizer = AutoTokenizer.from_pretrained(model_dir, local_files_only=True)
        self.session = ort.InferenceSession(
            str(model_dir / model_file),
            providers=["CPUExecutionProvider"],
        )
        self.batch_size = batch_size

    def encode(self, texts: list[str]) -> tuple[np.ndarray, list[float]]:
        vectors: list[np.ndarray] = []
        batch_times: list[float] = []
        for start in range(0, len(texts), self.batch_size):
            batch = texts[start : start + self.batch_size]
            tokens = self.tokenizer(
                batch,
                padding=True,
                truncation=True,
                max_length=2048,
                return_tensors="np",
            )
            inputs = {
                "input_ids": tokens["input_ids"].astype(np.int64),
                "attention_mask": tokens["attention_mask"].astype(np.int64),
            }
            started = time.perf_counter()
            result = self.session.run(["sentence_embedding"], inputs)[0]
            batch_times.append(time.perf_counter() - started)
            vectors.append(result)
        return normalize(np.concatenate(vectors, axis=0)), batch_times


def reciprocal_rank(ranked_ids: list[str], relevant: set[str]) -> float:
    for rank, document_id in enumerate(ranked_ids, start=1):
        if document_id in relevant:
            return 1.0 / rank
    return 0.0


def ndcg_at(ranked_ids: list[str], relevant: set[str], k: int) -> float:
    gains = [1.0 if document_id in relevant else 0.0 for document_id in ranked_ids[:k]]
    dcg = sum(gain / math.log2(rank + 2) for rank, gain in enumerate(gains))
    ideal = [1.0] * min(len(relevant), k)
    idcg = sum(gain / math.log2(rank + 2) for rank, gain in enumerate(ideal))
    return dcg / idcg if idcg else 0.0


def retrieval_metrics(
    documents: list[dict[str, Any]],
    queries: list[dict[str, Any]],
    document_vectors: np.ndarray,
    query_vectors: np.ndarray,
) -> dict[str, Any]:
    document_ids = [row["id"] for row in documents]
    per_query: list[dict[str, Any]] = []
    for query, vector in zip(queries, query_vectors, strict=True):
        scores = document_vectors @ vector
        order = np.argsort(-scores)
        ranked = [document_ids[index] for index in order]
        relevant = set(query["relevant"])
        per_query.append(
            {
                "id": query["id"],
                "language": query["language"],
                "top_3": [
                    {"id": document_ids[index], "score": round(float(scores[index]), 6)}
                    for index in order[:3]
                ],
                "recall_at_1": float(bool(set(ranked[:1]) & relevant)),
                "recall_at_3": float(bool(set(ranked[:3]) & relevant)),
                "mrr": reciprocal_rank(ranked, relevant),
                "ndcg_at_5": ndcg_at(ranked, relevant, 5),
            }
        )

    def averages(rows: list[dict[str, Any]]) -> dict[str, float]:
        return {
            metric: round(statistics.fmean(row[metric] for row in rows), 6)
            for metric in ("recall_at_1", "recall_at_3", "mrr", "ndcg_at_5")
        }

    languages = sorted({row["language"] for row in per_query})
    return {
        "overall": averages(per_query),
        "by_query_language": {
            language: averages([row for row in per_query if row["language"] == language])
            for language in languages
        },
        "queries": per_query,
    }


def confusion(labels: np.ndarray, scores: np.ndarray, threshold: float) -> dict[str, Any]:
    predicted = scores >= threshold
    tp = int(np.sum(predicted & labels))
    fp = int(np.sum(predicted & ~labels))
    fn = int(np.sum(~predicted & labels))
    tn = int(np.sum(~predicted & ~labels))
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {
        "threshold": round(float(threshold), 6),
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "tn": tn,
        "precision": round(precision, 6),
        "recall": round(recall, 6),
        "f1": round(f1, 6),
    }


def roc_auc(labels: np.ndarray, scores: np.ndarray) -> float:
    positives = scores[labels]
    negatives = scores[~labels]
    wins = sum(float(p > n) + 0.5 * float(p == n) for p in positives for n in negatives)
    return wins / (len(positives) * len(negatives))


def dedup_metrics(
    pairs: list[dict[str, Any]],
    left_vectors: np.ndarray,
    right_vectors: np.ndarray,
) -> dict[str, Any]:
    scores = np.sum(left_vectors * right_vectors, axis=1)
    labels = np.array([bool(pair["duplicate"]) for pair in pairs], dtype=bool)
    candidate_thresholds = sorted(
        {float(score) for score in scores}
        | {float(np.nextafter(score, np.inf)) for score in scores}
    )
    candidates = [confusion(labels, scores, threshold) for threshold in candidate_thresholds]
    best = max(candidates, key=lambda row: (row["f1"], row["precision"], row["recall"]))
    guards = {pair["id"]: hard_negative_conflict(pair) for pair in pairs if pair.get("guard")}
    guarded_predictions = np.array(
        [
            score >= 0.82 and not hard_negative_conflict(pair)
            for pair, score in zip(pairs, scores, strict=True)
        ],
        dtype=bool,
    )
    guarded = confusion(labels, guarded_predictions.astype(float), 1.0)
    return {
        "roc_auc": round(roc_auc(labels, scores), 6),
        "positive_score_range": [
            round(float(np.min(scores[labels])), 6),
            round(float(np.max(scores[labels])), 6),
        ],
        "negative_score_range": [
            round(float(np.min(scores[~labels])), 6),
            round(float(np.max(scores[~labels])), 6),
        ],
        "best_f1": best,
        "guarded_at_0_82": guarded,
        "hard_negative_guards": guards,
        "scoutpost_thresholds": [
            confusion(labels, scores, threshold) for threshold in SCOUTPOST_THRESHOLDS
        ],
        "pairs": [
            {
                "id": pair["id"],
                "duplicate": pair["duplicate"],
                "score": round(float(score), 6),
            }
            for pair, score in zip(pairs, scores, strict=True)
        ],
    }


def truncate(vectors: np.ndarray, dimensions: int) -> np.ndarray:
    return normalize(vectors[:, :dimensions].copy())


def load_distractors(directory: Path) -> list[dict[str, str]]:
    """Turn recorded public scrape baselines into overlapping retrieval chunks."""
    distractors: list[dict[str, str]] = []
    if not directory.exists():
        return distractors
    for source in sorted(directory.glob("*.md")):
        content = re.sub(r"\s+", " ", source.read_text(errors="replace")).strip()
        for offset in range(0, len(content), 700):
            chunk = content[offset : offset + 900].strip()
            if len(chunk) < 120:
                continue
            distractors.append(
                {
                    "id": f"distractor:{source.stem}:{offset // 700}",
                    "language": "unknown",
                    "title": source.stem.replace("_", " "),
                    "text": chunk,
                }
            )
    return distractors


def main() -> None:
    args = parse_args()
    fixtures = json.loads(args.fixtures.read_text())
    labelled_documents = fixtures["documents"]
    distractors = load_distractors(args.distractor_dir)
    documents = labelled_documents + distractors
    queries = fixtures["queries"]
    pairs = fixtures["dedup_pairs"]

    document_texts = [
        f"title: {row['title']} | text: {row['text']}" for row in documents
    ]
    query_texts = [f"task: search result | query: {row['text']}" for row in queries]
    # Production stores unit vectors as RETRIEVAL_DOCUMENT embeddings. Dedup
    # calibration must measure that exact prefix contract, not the model's
    # separate sentence-similarity task.
    left_texts = [f"title: information unit | text: {row['left']}" for row in pairs]
    right_texts = [f"title: information unit | text: {row['right']}" for row in pairs]

    process = psutil.Process(os.getpid())
    rss_before = process.memory_info().rss
    load_started = time.perf_counter()
    embedder = LocalEmbedder(args.model_dir, args.model_file, args.batch_size)
    load_seconds = time.perf_counter() - load_started
    rss_loaded = process.memory_info().rss

    # Warm the graph before measuring inference.
    embedder.encode(["task: sentence similarity | query: warmup"])
    all_texts = document_texts + query_texts + left_texts + right_texts
    vectors, batch_times = embedder.encode(all_texts)
    rss_peak = process.memory_info().rss

    document_end = len(documents)
    query_end = document_end + len(queries)
    left_end = query_end + len(pairs)
    document_vectors = vectors[:document_end]
    query_vectors = vectors[document_end:query_end]
    left_vectors = vectors[query_end:left_end]
    right_vectors = vectors[left_end:]

    dimensions: dict[str, Any] = {}
    for dimension in SUPPORTED_DIMENSIONS:
        dimensions[str(dimension)] = {
            "retrieval": retrieval_metrics(
                documents,
                queries,
                truncate(document_vectors, dimension),
                truncate(query_vectors, dimension),
            ),
            "dedup": dedup_metrics(
                pairs,
                truncate(left_vectors, dimension),
                truncate(right_vectors, dimension),
            ),
        }

    total_inference = sum(batch_times)
    identity = artifact_identity(args.model_dir, args.model_file)
    failures: list[str] = []
    if not args.reference_full_precision and (
        args.model_file != EXPECTED_MODEL_FILE or args.precision != "int8"
    ):
        failures.append("runtime must use the pinned INT8 model file and precision label")
    if identity["revision"] != EXPECTED_REVISION:
        failures.append("Hugging Face artifact revision does not match the pinned revision")
    if (
        not args.reference_full_precision
        and identity["model_sha256"] != EXPECTED_MODEL_SHA256
    ):
        failures.append("quantized ONNX graph checksum mismatch")
    if (
        not args.reference_full_precision
        and identity["data_sha256"] != EXPECTED_DATA_SHA256
    ):
        failures.append("quantized ONNX data checksum mismatch")
    if args.reference_full_precision and (
        identity["model_sha256"] != EXPECTED_FP32_MODEL_SHA256
        or identity["data_sha256"] != EXPECTED_FP32_DATA_SHA256
    ):
        failures.append("full-precision ONNX reference checksum mismatch")
    if len(distractors) < 700:
        failures.append("retrieval corpus is missing the recorded realistic distractors")
    if not np.isfinite(vectors).all():
        failures.append("model returned non-finite vector values")
    if not np.allclose(np.linalg.norm(vectors[:, :768], axis=1), 1.0, atol=1e-4):
        failures.append("768-dimensional vectors are not unit normalized")

    quality = dimensions["768"]
    retrieval = quality["retrieval"]["overall"]
    dedup = quality["dedup"]
    if retrieval["recall_at_1"] < 1.0 or retrieval["mrr"] < 1.0:
        failures.append("768-dimensional retrieval regressed below the recorded baseline")
    if (
        not args.reference_full_precision
        and dedup["roc_auc"] < FULL_PRECISION_BASELINE["roc_auc"] - QUALITY_TOLERANCE
    ):
        failures.append("INT8 dedup ROC AUC falls below the full-precision tolerance")
    if (
        not args.reference_full_precision
        and dedup["best_f1"]["f1"]
        < FULL_PRECISION_BASELINE["best_f1"] - QUALITY_TOLERANCE
    ):
        failures.append("INT8 dedup F1 falls below the full-precision tolerance")
    if not dedup["hard_negative_guards"] or not all(
        dedup["hard_negative_guards"].values()
    ):
        failures.append("one or more structured hard-negative guards failed")
    if dedup["guarded_at_0_82"]["f1"] < 0.90:
        failures.append("guarded production dedup F1 is below 0.90 at threshold 0.82")
    report = {
        "model": f"onnx-community/embeddinggemma-300m-ONNX@{EXPECTED_REVISION}",
        "artifact": identity,
        "model_file": args.model_file,
        "precision": args.precision,
        "reference_full_precision": args.reference_full_precision,
        "fixture_counts": {
            "labelled_documents": len(labelled_documents),
            "distractor_documents": len(distractors),
            "documents": len(documents),
            "queries": len(queries),
            "dedup_pairs": len(pairs),
            "dedup_positive": sum(bool(row["duplicate"]) for row in pairs),
            "dedup_negative": sum(not bool(row["duplicate"]) for row in pairs),
        },
        "runtime": {
            "load_seconds": round(load_seconds, 6),
            "inference_seconds": round(total_inference, 6),
            "texts": len(all_texts),
            "texts_per_second": round(len(all_texts) / total_inference, 6),
            "batch_size": args.batch_size,
            "batch_p50_seconds": round(statistics.median(batch_times), 6),
            "batch_max_seconds": round(max(batch_times), 6),
            "rss_before_mb": round(rss_before / 1024**2, 3),
            "rss_after_load_mb": round(rss_loaded / 1024**2, 3),
            "rss_after_inference_mb": round(rss_peak / 1024**2, 3),
        },
        "dimensions": dimensions,
        "gate": {"passed": not failures, "failures": failures},
    }

    rendered = json.dumps(report, indent=2, ensure_ascii=False)
    if args.output:
        args.output.write_text(rendered + "\n")
    print(rendered)
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()

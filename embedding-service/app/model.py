"""Pinned local EmbeddingGemma ONNX runtime and task-prefix contract."""

from __future__ import annotations

from pathlib import Path
from typing import Literal

import numpy as np
import onnxruntime as ort
from transformers import AutoTokenizer

from .config import EMBEDDING_DIMENSIONS

TaskType = Literal[
    "SEMANTIC_SIMILARITY",
    "RETRIEVAL_DOCUMENT",
    "RETRIEVAL_QUERY",
    "CLASSIFICATION",
    "CLUSTERING",
]


def format_embedding_text(text: str, task_type: TaskType, title: str | None = None) -> str:
    """Apply the prompts recommended by the EmbeddingGemma model card."""
    if task_type == "RETRIEVAL_DOCUMENT":
        clean_title = (title or "").strip() or "none"
        return f"title: {clean_title} | text: {text}"

    prefixes = {
        "SEMANTIC_SIMILARITY": "task: sentence similarity | query: ",
        "RETRIEVAL_QUERY": "task: search result | query: ",
        "CLASSIFICATION": "task: classification | query: ",
        "CLUSTERING": "task: clustering | query: ",
    }
    return f"{prefixes[task_type]}{text}"


class EmbeddingModel:
    """One process-local INT8 ONNX session; callers bound concurrency outside."""

    def __init__(self, model_dir: str) -> None:
        root = Path(model_dir)
        self.tokenizer = AutoTokenizer.from_pretrained(root, local_files_only=True)
        options = ort.SessionOptions()
        options.inter_op_num_threads = 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        self.session = ort.InferenceSession(
            str(root / "onnx" / "model_quantized.onnx"),
            sess_options=options,
            providers=["CPUExecutionProvider"],
        )

    def encode(self, texts: list[str]) -> list[list[float]]:
        tokens = self.tokenizer(
            texts,
            padding=True,
            truncation=True,
            max_length=2048,
            return_tensors="np",
        )
        inputs = {
            "input_ids": tokens["input_ids"].astype(np.int64),
            "attention_mask": tokens["attention_mask"].astype(np.int64),
        }
        vectors = self.session.run(["sentence_embedding"], inputs)[0]
        vectors = vectors[:, :EMBEDDING_DIMENSIONS].astype(np.float32, copy=False)
        norms = np.linalg.norm(vectors, axis=1, keepdims=True)
        vectors = vectors / np.maximum(norms, np.finfo(np.float32).eps)
        return vectors.tolist()

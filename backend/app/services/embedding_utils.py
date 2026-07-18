"""Shared OpenRouter Gemini embedding client and vector utilities."""

import base64
import logging
import math
import struct
from typing import List, Optional

import httpx
import numpy as np

from app.config import settings
from app.services.http_client import get_http_client

logger = logging.getLogger(__name__)

OPENROUTER_EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings"
OPENROUTER_EMBEDDING_MODEL = "google/gemini-embedding-001"
EMBEDDING_DIMENSIONS = 768
EMBEDDING_MODEL_TAG = "openrouter-google-gemini-embedding-001-768-zdr-v1"
PROVIDER_POLICY = {
    "only": ["google-vertex"],
    "allow_fallbacks": False,
    "zdr": True,
    "data_collection": "deny",
}


class EmbeddingError(RuntimeError):
    """A secret-safe embedding configuration, transport, or response error."""


class _EmbeddingProviderError(EmbeddingError):
    """An HTTP error that existing batch callers may treat as best effort."""


def normalize_embedding(values: list[float]) -> list[float]:
    """Normalize an embedding to unit length as a storage-boundary safeguard."""
    arr = np.array(values, dtype=np.float32)
    norm = np.linalg.norm(arr)
    if norm == 0:
        return values
    return (arr / norm).tolist()


def _api_key() -> str:
    key = settings.openrouter_api_key.strip()
    if not key:
        raise EmbeddingError("OPENROUTER_API_KEY not configured")
    return key


def _input_type(task_type: str) -> str:
    return {
        "SEMANTIC_SIMILARITY": "semantic_similarity",
        "RETRIEVAL_DOCUMENT": "search_document",
        "RETRIEVAL_QUERY": "search_query",
        "CLASSIFICATION": "classification",
        "CLUSTERING": "clustering",
    }.get(task_type, "semantic_similarity")


def _format_input(text: str, task_type: str, title: Optional[str]) -> str:
    if task_type == "RETRIEVAL_DOCUMENT" and title and title.strip():
        return f"title: {title.strip()} | text: {text}"
    return text


async def _request_embeddings(
    texts: list[str],
    task_type: str,
    titles: list[Optional[str]],
) -> list[list[float]]:
    key = _api_key()
    client = await get_http_client()
    try:
        response = await client.post(
            OPENROUTER_EMBEDDINGS_URL,
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
                "X-OpenRouter-Cache": "false",
            },
            json={
                "model": OPENROUTER_EMBEDDING_MODEL,
                "input": [
                    _format_input(text, task_type, titles[index])
                    for index, text in enumerate(texts)
                ],
                "dimensions": EMBEDDING_DIMENSIONS,
                "input_type": _input_type(task_type),
                "provider": PROVIDER_POLICY,
            },
        )
    except httpx.HTTPError:
        logger.error("OpenRouter embedding transport failed")
        raise _EmbeddingProviderError("OpenRouter embedding request failed") from None
    if response.status_code != 200:
        logger.error("OpenRouter embedding failed with status %s", response.status_code)
        raise _EmbeddingProviderError(
            f"OpenRouter embedding failed with status {response.status_code}"
        )

    try:
        body = response.json()
    except (TypeError, ValueError):
        raise EmbeddingError("OpenRouter embedding returned malformed JSON") from None

    data = body.get("data") if isinstance(body, dict) else None
    if not isinstance(data, list) or len(data) != len(texts):
        raise EmbeddingError("OpenRouter embedding returned an unexpected count")

    ordered: list[Optional[list[float]]] = [None] * len(texts)
    for item in data:
        if not isinstance(item, dict):
            raise EmbeddingError("OpenRouter embedding returned an invalid item")
        index = item.get("index")
        if (
            type(index) is not int
            or index < 0
            or index >= len(texts)
            or ordered[index] is not None
        ):
            raise EmbeddingError("OpenRouter embedding returned an invalid index")
        vector = item.get("embedding")
        if (
            not isinstance(vector, list)
            or len(vector) != EMBEDDING_DIMENSIONS
            or any(
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(float(value))
                for value in vector
            )
        ):
            raise EmbeddingError("OpenRouter embedding returned an invalid vector")
        normalized = normalize_embedding([float(value) for value in vector])
        if not all(math.isfinite(value) for value in normalized):
            raise EmbeddingError("OpenRouter embedding returned an invalid vector")
        ordered[index] = normalized

    if any(vector is None for vector in ordered):
        raise EmbeddingError("OpenRouter embedding omitted an input index")
    usage = body.get("usage") if isinstance(body, dict) else None
    if isinstance(usage, dict):
        logger.info(
            "OpenRouter embedding usage model=%s dimensions=%s inputs=%s tokens=%s cost=%s zdr=true upstream=google-vertex",
            body.get("model", OPENROUTER_EMBEDDING_MODEL),
            EMBEDDING_DIMENSIONS,
            len(texts),
            usage.get("prompt_tokens"),
            usage.get("cost"),
        )
    return [vector for vector in ordered if vector is not None]


async def generate_embedding(
    text: str,
    task_type: str = "SEMANTIC_SIMILARITY",
    title: Optional[str] = None,
) -> List[float]:
    values = await _request_embeddings([text], task_type, [title])
    return values[0]


async def generate_embeddings_batch(
    texts: List[str],
    task_type: str = "SEMANTIC_SIMILARITY",
    titles: Optional[List[Optional[str]]] = None,
) -> List[List[float]]:
    if not texts:
        return []
    if titles is not None and len(titles) != len(texts):
        raise ValueError("titles must be the same length as texts")
    resolved_titles = titles if titles is not None else [None] * len(texts)
    try:
        return await _request_embeddings(texts, task_type, resolved_titles)
    except _EmbeddingProviderError:
        return []


def cosine_similarity(a: list[float], b: list[float]) -> float:
    """Calculate cosine similarity between two vectors with zero-norm protection."""
    a_arr, b_arr = np.array(a), np.array(b)
    norm_a, norm_b = np.linalg.norm(a_arr), np.linalg.norm(b_arr)
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return float(np.dot(a_arr, b_arr) / (norm_a * norm_b))


def compress_embedding(embedding: list[float]) -> str:
    """Compress an embedding to the existing base64-encoded float32 format."""
    packed = struct.pack(f"{len(embedding)}f", *embedding)
    return base64.b64encode(packed).decode()


def decompress_embedding(compressed: str) -> list[float]:
    """Decompress the existing base64-encoded float32 embedding format."""
    packed = base64.b64decode(compressed)
    return list(struct.unpack(f"{len(packed) // 4}f", packed))

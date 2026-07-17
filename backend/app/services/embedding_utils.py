"""Shared client and vector utilities for local EmbeddingGemma inference.

The embedding model runs in Scoutpost's authenticated embedding service. The
service applies task prefixes and returns one pinned 768-dimensional model
space; this module validates that contract before vectors reach storage.
"""

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

EMBEDDING_DIMENSIONS = 768
EMBEDDING_MODEL_TAG = "embeddinggemma-300m-768-int8-onnx-task-prefix-v1"


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


def _service_configuration() -> tuple[str, str]:
    url = settings.embedding_service_url.strip().rstrip("/")
    token = settings.embedding_service_token.strip()
    if not url:
        raise EmbeddingError("EMBEDDING_SERVICE_URL not configured")
    if not token:
        raise EmbeddingError("EMBEDDING_SERVICE_TOKEN not configured")
    return url, token


async def _request_embeddings(inputs: list[dict[str, object]]) -> list[list[float]]:
    url, token = _service_configuration()
    client = await get_http_client()
    try:
        response = await client.post(
            f"{url}/embed",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            json={"inputs": inputs},
        )
    except httpx.HTTPError:
        logger.error("Embedding service transport failed")
        raise _EmbeddingProviderError("Embedding service request failed") from None
    if response.status_code != 200:
        logger.error("Embedding service failed with status %s", response.status_code)
        raise _EmbeddingProviderError(
            f"Embedding service failed with status {response.status_code}"
        )

    try:
        body = response.json()
    except (TypeError, ValueError):
        raise EmbeddingError("Embedding service returned malformed JSON") from None

    if (
        not isinstance(body, dict)
        or body.get("model") != EMBEDDING_MODEL_TAG
        or body.get("dimensions") != EMBEDDING_DIMENSIONS
    ):
        raise EmbeddingError("Embedding service model contract mismatch")
    data = body.get("data")
    if not isinstance(data, list) or len(data) != len(inputs):
        raise EmbeddingError("Embedding service returned an unexpected embedding count")

    ordered: list[Optional[list[float]]] = [None] * len(inputs)
    for item in data:
        if not isinstance(item, dict):
            raise EmbeddingError("Embedding service returned an invalid item")
        index = item.get("index")
        if (
            type(index) is not int
            or index < 0
            or index >= len(inputs)
            or ordered[index] is not None
        ):
            raise EmbeddingError("Embedding service returned an invalid index")
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
            raise EmbeddingError("Embedding service returned an invalid vector")
        normalized = normalize_embedding([float(value) for value in vector])
        if not all(math.isfinite(value) for value in normalized):
            raise EmbeddingError("Embedding service returned an invalid vector")
        ordered[index] = normalized

    if any(vector is None for vector in ordered):
        raise EmbeddingError("Embedding service omitted an input index")
    return [vector for vector in ordered if vector is not None]


async def generate_embedding(
    text: str,
    task_type: str = "SEMANTIC_SIMILARITY",
    title: Optional[str] = None,
) -> List[float]:
    values = await _request_embeddings(
        [{"text": text, "task_type": task_type, "title": title}]
    )
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
    inputs = [
        {
            "text": text,
            "task_type": task_type,
            "title": titles[index] if titles is not None else None,
        }
        for index, text in enumerate(texts)
    ]
    try:
        return await _request_embeddings(inputs)
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

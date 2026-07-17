"""Fail-closed configuration for the internal embedding service."""

from __future__ import annotations

import os
from dataclasses import dataclass


MODEL_REPOSITORY = "onnx-community/embeddinggemma-300m-ONNX"
MODEL_REVISION = "5090578d9565bb06545b4552f76e6bc2c93e4a66"
MODEL_TAG = "embeddinggemma-300m-768-int8-onnx-task-prefix-v1"
EMBEDDING_DIMENSIONS = 768


@dataclass(frozen=True)
class Settings:
    token: str | None
    model_dir: str
    max_batch_size: int
    max_text_chars: int
    inference_concurrency: int
    max_queued_requests: int
    admission_timeout_seconds: float


def load_settings(env: dict[str, str] | None = None) -> Settings:
    values = os.environ if env is None else env
    token = values.get("EMBEDDING_SERVICE_TOKEN") or None
    allow_anon = values.get("EMBEDDING_SERVICE_DEV_NO_AUTH") == "1"
    if token is None and not allow_anon:
        raise RuntimeError(
            "EMBEDDING_SERVICE_TOKEN is not set. Refusing to expose document "
            "embeddings without authentication. Set the token, or use "
            "EMBEDDING_SERVICE_DEV_NO_AUTH=1 for a local playground only."
        )

    max_batch_size = int(values.get("EMBEDDING_MAX_BATCH_SIZE", "32"))
    max_text_chars = int(values.get("EMBEDDING_MAX_TEXT_CHARS", "100000"))
    inference_concurrency = int(values.get("EMBEDDING_INFERENCE_CONCURRENCY", "1"))
    max_queued_requests = int(values.get("EMBEDDING_MAX_QUEUED_REQUESTS", "8"))
    admission_timeout_seconds = float(
        values.get("EMBEDDING_ADMISSION_TIMEOUT_SECONDS", "0.1")
    )
    if (
        max_batch_size < 1
        or max_text_chars < 1
        or inference_concurrency < 1
        or max_queued_requests < 0
        or admission_timeout_seconds <= 0
    ):
        raise RuntimeError("Embedding service numeric limits are invalid")

    return Settings(
        token=token,
        model_dir=values.get("EMBEDDING_MODEL_DIR", "/models/embeddinggemma"),
        max_batch_size=max_batch_size,
        max_text_chars=max_text_chars,
        inference_concurrency=inference_concurrency,
        max_queued_requests=max_queued_requests,
        admission_timeout_seconds=admission_timeout_seconds,
    )

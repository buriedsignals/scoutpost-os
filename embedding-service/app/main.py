"""Authenticated HTTP boundary around Scoutpost's local EmbeddingGemma model."""

from __future__ import annotations

import asyncio
import secrets
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field

from .config import EMBEDDING_DIMENSIONS, MODEL_REVISION, MODEL_TAG, Settings, load_settings
from .model import EmbeddingModel, TaskType, format_embedding_text

_bearer = HTTPBearer(auto_error=False)


class EmbedInput(BaseModel):
    text: str = Field(min_length=1)
    task_type: TaskType = "SEMANTIC_SIMILARITY"
    title: str | None = None


class EmbedBody(BaseModel):
    inputs: list[EmbedInput] = Field(min_length=1)


def create_app(
    settings: Settings | None = None,
    model: EmbeddingModel | None = None,
) -> FastAPI:
    resolved = settings if settings is not None else load_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if app.state.model is None:
            app.state.model = await asyncio.to_thread(EmbeddingModel, resolved.model_dir)
        yield

    app = FastAPI(
        title="scoutpost-embedding-service",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    app.state.settings = resolved
    app.state.model = model
    app.state.inference_gate = asyncio.Semaphore(resolved.inference_concurrency)
    app.state.admission_gate = asyncio.Semaphore(
        resolved.inference_concurrency + resolved.max_queued_requests
    )

    def require_token(
        request: Request,
        credentials: Annotated[
            HTTPAuthorizationCredentials | None,
            Depends(_bearer),
        ],
    ) -> None:
        expected = request.app.state.settings.token
        if expected is None:
            return
        if credentials is None or not secrets.compare_digest(
            credentials.credentials, expected
        ):
            raise HTTPException(status_code=401, detail="invalid or missing bearer token")

    @app.get("/health")
    async def health(request: Request):
        return {
            "status": "ok" if request.app.state.model is not None else "loading",
            "model": MODEL_TAG,
            "revision": MODEL_REVISION,
            "dimensions": EMBEDDING_DIMENSIONS,
        }

    @app.post("/embed", dependencies=[Depends(require_token)])
    async def embed(body: EmbedBody, request: Request):
        cfg: Settings = request.app.state.settings
        if len(body.inputs) > cfg.max_batch_size:
            raise HTTPException(status_code=413, detail="embedding batch is too large")
        if any(len(item.text) > cfg.max_text_chars for item in body.inputs):
            raise HTTPException(status_code=413, detail="embedding input is too large")
        texts = [
            format_embedding_text(item.text, item.task_type, item.title)
            for item in body.inputs
        ]
        try:
            await asyncio.wait_for(
                request.app.state.admission_gate.acquire(),
                timeout=cfg.admission_timeout_seconds,
            )
        except TimeoutError:
            raise HTTPException(
                status_code=503, detail="embedding service is at capacity"
            ) from None
        try:
            async with request.app.state.inference_gate:
                vectors = await asyncio.to_thread(request.app.state.model.encode, texts)
        finally:
            request.app.state.admission_gate.release()
        if len(vectors) != len(texts):
            raise HTTPException(status_code=500, detail="embedding model returned the wrong count")
        return {
            "model": MODEL_TAG,
            "dimensions": EMBEDDING_DIMENSIONS,
            "data": [
                {"index": index, "embedding": vector}
                for index, vector in enumerate(vectors)
            ],
        }

    return app

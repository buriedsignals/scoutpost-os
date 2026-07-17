from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace

from fastapi.testclient import TestClient

from app.config import EMBEDDING_DIMENSIONS, MODEL_TAG, Settings, load_settings
from app.main import create_app
from app.model import format_embedding_text


class FakeModel:
    def __init__(self) -> None:
        self.inputs: list[str] = []

    def encode(self, texts: list[str]) -> list[list[float]]:
        self.inputs = texts
        return [[float(index)] * EMBEDDING_DIMENSIONS for index, _ in enumerate(texts)]


class BlockingModel:
    def __init__(self) -> None:
        self.started = threading.Event()
        self.release = threading.Event()

    def encode(self, texts: list[str]) -> list[list[float]]:
        self.started.set()
        assert self.release.wait(timeout=2)
        return [[0.0] * EMBEDDING_DIMENSIONS for _ in texts]


def settings(token: str | None = "test-token") -> Settings:
    return Settings(
        token=token,
        model_dir="unused",
        max_batch_size=2,
        max_text_chars=100,
        inference_concurrency=1,
        max_queued_requests=8,
        admission_timeout_seconds=0.1,
    )


def test_configuration_fails_closed_without_token():
    try:
        load_settings({})
    except RuntimeError as error:
        assert "EMBEDDING_SERVICE_TOKEN" in str(error)
    else:
        raise AssertionError("missing token must fail closed")


def test_task_prefix_contract():
    assert format_embedding_text("budget", "RETRIEVAL_QUERY") == (
        "task: search result | query: budget"
    )
    assert format_embedding_text("minutes", "RETRIEVAL_DOCUMENT", "Council") == (
        "title: Council | text: minutes"
    )


def test_embed_is_authenticated_ordered_and_reports_model_contract():
    model = FakeModel()
    with TestClient(create_app(settings(), model)) as client:
        assert client.post("/embed", json={"inputs": [{"text": "x"}]}).status_code == 401
        response = client.post(
            "/embed",
            headers={"Authorization": "Bearer test-token"},
            json={
                "inputs": [
                    {"text": "alpha", "task_type": "RETRIEVAL_QUERY"},
                    {"text": "beta", "task_type": "RETRIEVAL_DOCUMENT", "title": "B"},
                ]
            },
        )
    assert response.status_code == 200
    assert response.json()["model"] == MODEL_TAG
    assert response.json()["dimensions"] == EMBEDDING_DIMENSIONS
    assert [item["index"] for item in response.json()["data"]] == [0, 1]
    assert len(response.json()["data"][0]["embedding"]) == EMBEDDING_DIMENSIONS
    assert model.inputs == [
        "task: search result | query: alpha",
        "title: B | text: beta",
    ]


def test_embed_enforces_batch_and_input_limits():
    with TestClient(create_app(settings(), FakeModel())) as client:
        headers = {"Authorization": "Bearer test-token"}
        too_many = client.post(
            "/embed",
            headers=headers,
            json={"inputs": [{"text": "a"}, {"text": "b"}, {"text": "c"}]},
        )
        too_large = client.post(
            "/embed",
            headers=headers,
            json={"inputs": [{"text": "x" * 101}]},
        )
    assert too_many.status_code == 413
    assert too_large.status_code == 413


def test_embed_rejects_requests_when_inference_and_queue_are_full():
    model = BlockingModel()
    cfg = replace(
        settings(),
        max_queued_requests=0,
        admission_timeout_seconds=0.02,
    )
    with TestClient(create_app(cfg, model)) as client:
        headers = {"Authorization": "Bearer test-token"}
        body = {"inputs": [{"text": "alpha"}]}
        with ThreadPoolExecutor(max_workers=1) as executor:
            first = executor.submit(client.post, "/embed", headers=headers, json=body)
            assert model.started.wait(timeout=1)
            saturated = client.post("/embed", headers=headers, json=body)
            model.release.set()
            completed = first.result(timeout=2)
    assert saturated.status_code == 503
    assert completed.status_code == 200

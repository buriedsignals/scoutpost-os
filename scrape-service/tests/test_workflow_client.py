import base64
import json

import httpx
import pytest
from app import workflow_client
from app.workflow_client import (
    ArtifactLimitError,
    CallbackTimeoutError,
    SignedUploadError,
    WorkflowClient,
)


class FakeResponse:
    def __init__(self, status=200, body=None):
        self.status_code = status
        self._body = body or {}
        self.closed = False

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                "control failed",
                request=httpx.Request("POST", "https://worker.test"),
                response=httpx.Response(self.status_code),
            )

    def json(self):
        return self._body

    async def aclose(self):
        self.closed = True


class FakeHttp:
    def __init__(self, *, headers=None, **_kwargs):
        self.headers = headers or {}
        self.posts = []
        self.puts = []
        self.post_response = FakeResponse(body={"jobs": []})
        self.put_response = FakeResponse(status=200)

    async def post(self, url, json, **_kwargs):
        self.posts.append((url, json))
        return self.post_response

    async def put(self, url, body, headers):
        self.puts.append((url, body, headers))
        return self.put_response

    async def aclose(self):
        pass


@pytest.fixture
def client(monkeypatch):
    created = []

    def factory(**kwargs):
        item = FakeHttp(**kwargs)
        created.append(item)
        return item

    monkeypatch.setenv("WORKFLOW_WORKER_URL", "https://worker.test")
    monkeypatch.setenv("WORKFLOW_WORKER_TOKEN", "worker-secret")
    monkeypatch.setattr(workflow_client.httpx, "AsyncClient", factory)
    value = WorkflowClient("http://127.0.0.1:1234")
    value._created = created
    return value


async def test_claim_uses_worker_bearer_but_upload_client_does_not(client):
    assert client.control_http.headers["authorization"] == "Bearer worker-secret"
    assert "authorization" not in client.upload_http.headers
    assert await client.claim("00000000-0000-4000-8000-000000000001") == []
    assert client.control_http.posts[0][1]["execution_id"] == client.execution_id


async def test_upload_separates_snapshot_artifacts(client):
    png = b"\x89PNG\r\n\x1a\nimage"
    job = {
        "id": "job",
        "attempt_id": "attempt",
        "execution_id": client.execution_id,
        "uploads": {
            "result": {"url": "https://storage.test/result?token=one"},
            "mhtml": {"url": "https://storage.test/mhtml?token=two"},
            "screenshot": {"url": "https://storage.test/png?token=three"},
        },
    }
    completion = await client.upload(
        job,
        {
            "markdown": "content",
            "source_url": "https://example.test",
            "snapshot": {
                "mhtml_b64": base64.b64encode(b"mhtml").decode(),
                "screenshot_b64": base64.b64encode(png).decode(),
                "mhtml_sha256": "metadata",
            },
        },
    )
    assert [item["kind"] for item in completion["artifacts"]] == [
        "result",
        "mhtml",
        "screenshot",
    ]
    result_json = json.loads(
        __import__("gzip").decompress(client.upload_http.puts[0][1]).decode()
    )
    assert "mhtml_b64" not in result_json["snapshot"]
    assert len(client.upload_http.puts) == 3


async def test_signed_upload_errors_never_include_url_or_token(client):
    secret_url = "https://storage.test/object?token=do-not-log"

    async def fail(*_args, **_kwargs):
        raise httpx.ConnectError(f"failed {secret_url}")

    client.upload_http.put = fail
    with pytest.raises(SignedUploadError) as caught:
        await client._upload({"url": secret_url}, b"x", "application/gzip")
    assert secret_url not in str(caught.value)
    assert "do-not-log" not in str(caught.value)


async def test_signed_upload_http_status_is_sanitized(client):
    client.upload_http.put_response = FakeResponse(status=403)
    with pytest.raises(SignedUploadError, match="signed_upload_http_403"):
        await client._upload(
            {"url": "https://storage.test/object?token=secret"},
            b"x",
            "application/gzip",
        )


async def test_artifact_limits_and_png_validation(client, monkeypatch):
    monkeypatch.setattr(workflow_client, "RESULT_JSON_DECODED_MAX", 2)
    with pytest.raises(ArtifactLimitError, match="result JSON"):
        await client.upload(
            {"uploads": {"result": {"url": "https://storage.test"}}},
            {"markdown": "too large"},
        )
    monkeypatch.setattr(workflow_client, "RESULT_JSON_DECODED_MAX", 1024)
    with pytest.raises(ArtifactLimitError, match="not PNG"):
        await client.upload(
            {
                "id": "j",
                "attempt_id": "a",
                "execution_id": "e",
                "uploads": {
                    "result": {"url": "https://storage.test/result"},
                    "screenshot": {"url": "https://storage.test/png"},
                },
            },
            {
                "markdown": "ok",
                "snapshot": {"screenshot_b64": base64.b64encode(b"not-png").decode()},
            },
        )


@pytest.mark.parametrize(
    ("field", "limit_name", "message"),
    [
        ("mhtml_b64", "SNAPSHOT_ARTIFACT_DECODED_MAX", "MHTML"),
        ("screenshot_b64", "SNAPSHOT_ARTIFACT_DECODED_MAX", "screenshot artifact"),
    ],
)
async def test_individual_snapshot_caps(
    client, monkeypatch, field, limit_name, message
):
    monkeypatch.setattr(workflow_client, limit_name, 1)
    value = b"\x89PNG\r\n\x1a\n" if field == "screenshot_b64" else b"xx"
    with pytest.raises(ArtifactLimitError, match=message):
        await client.upload(
            {"uploads": {"result": {"url": "https://storage.test"}}},
            {"markdown": "ok", "snapshot": {field: base64.b64encode(value).decode()}},
        )


async def test_combined_snapshot_cap_and_invalid_encoding(client, monkeypatch):
    monkeypatch.setattr(workflow_client, "SNAPSHOT_COMBINED_DECODED_MAX", 1)
    with pytest.raises(ArtifactLimitError, match="snapshot bundle"):
        await client.upload(
            {"uploads": {"result": {"url": "https://storage.test"}}},
            {
                "markdown": "ok",
                "snapshot": {
                    "mhtml_b64": base64.b64encode(b"x").decode(),
                    "screenshot_b64": base64.b64encode(b"y").decode(),
                },
            },
        )
    with pytest.raises(ArtifactLimitError, match="invalid snapshot encoding"):
        await client.upload(
            {"uploads": {"result": {"url": "https://storage.test"}}},
            {"markdown": "ok", "snapshot": {"mhtml_b64": "%%%"}},
        )


async def test_compressed_artifact_rejects_empty_and_over_cap(client, monkeypatch):
    with pytest.raises(ArtifactLimitError, match="compressed artifact"):
        await client._upload({"url": "https://storage.test"}, b"", "x")
    monkeypatch.setattr(workflow_client, "COMPRESSED_ARTIFACT_MAX", 1)
    with pytest.raises(ArtifactLimitError, match="compressed artifact"):
        await client._upload({"url": "https://storage.test"}, b"xx", "x")


async def test_claim_rejects_oversized_response(client):
    client.control_http.post_response = FakeResponse(body={"jobs": [{}] * 21})
    with pytest.raises(RuntimeError, match="invalid crawler claim"):
        await client.claim("batch")


async def test_complete_posts_one_result(client):
    await client.complete("batch", {"job_id": "job", "ok": False})
    assert client.control_http.posts[-1][1] == {
        "action": "complete",
        "batch_id": "batch",
        "results": [{"job_id": "job", "ok": False}],
    }
    await client.complete(
        "batch",
        {"job_id": "job", "ok": False},
        response_delay_ms=1_000,
        timeout_seconds=0.1,
    )
    assert client.control_http.posts[-1][1]["response_delay_ms"] == 1_000

    async def timeout(*_args, **_kwargs):
        raise httpx.ReadTimeout("signed worker URL must not escape")

    client.control_http.post = timeout
    with pytest.raises(CallbackTimeoutError, match="crawler_callback_timeout"):
        await client.complete("batch", {"job_id": "job", "ok": False})
    await client.close()

import base64
import json

import httpx
import pytest

from app import openrouter_pdf
from app.openrouter_pdf import OpenRouterParseError, transcribe_pdf
from tests.conftest import mock_http_client

PDF = b"%PDF-1.4 fake bytes"


def _client(handler):
    return mock_http_client(handler)


async def test_transcribe_sends_native_vertex_zdr_request_and_returns_text():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url == httpx.URL(
            "https://openrouter.ai/api/v1/chat/completions"
        )
        assert request.headers["Authorization"] == "Bearer or-key"
        assert request.headers["X-OpenRouter-Cache"] == "false"

        body = json.loads(request.content)
        assert body["model"] == "google/gemini-2.5-flash-lite"
        assert body["temperature"] == 0
        assert body["provider"] == {
            "only": ["google-vertex"],
            "zdr": True,
            "data_collection": "deny",
            "require_parameters": True,
        }
        assert body["plugins"] == [
            {"id": "file-parser", "pdf": {"engine": "native"}}
        ]
        content = body["messages"][0]["content"]
        assert body["messages"][0]["role"] == "user"
        assert [part["type"] for part in content] == ["file", "text"]
        assert content[1]["text"] == openrouter_pdf.TRANSCRIBE_PROMPT
        assert content[0]["file"]["filename"] == "document.pdf"
        prefix = "data:application/pdf;base64,"
        data_url = content[0]["file"]["file_data"]
        assert data_url.startswith(prefix)
        assert base64.b64decode(data_url.removeprefix(prefix)) == PDF
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {"content": "# Doc\n\nbody"},
                        "finish_reason": "stop",
                    }
                ]
            },
        )

    out = await transcribe_pdf(
        _client(handler),
        PDF,
        api_key="or-key",
        model="google/gemini-2.5-flash-lite",
        timeout_s=5,
    )
    assert out == "# Doc\n\nbody"


async def test_transcribe_http_error_is_status_only_and_secret_safe():
    secret = "secret-must-not-leak"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, json={"error": f"bad key {secret}"})

    with pytest.raises(OpenRouterParseError, match="HTTP 429") as caught:
        await transcribe_pdf(
            _client(handler), PDF, api_key=secret, model="model", timeout_s=5
        )
    assert secret not in caught.value.detail
    assert "bad key" not in caught.value.detail


async def test_transcribe_timeout_is_secret_safe():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow with secret-must-not-leak", request=request)

    with pytest.raises(OpenRouterParseError, match="timed out: ReadTimeout") as caught:
        await transcribe_pdf(
            _client(handler),
            PDF,
            api_key="secret-must-not-leak",
            model="model",
            timeout_s=0.01,
        )
    assert "secret-must-not-leak" not in caught.value.detail


async def test_transcribe_network_error_is_secret_safe():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused with secret-must-not-leak", request=request)

    with pytest.raises(OpenRouterParseError, match="failed: ConnectError") as caught:
        await transcribe_pdf(
            _client(handler),
            PDF,
            api_key="secret-must-not-leak",
            model="model",
            timeout_s=5,
        )
    assert "secret-must-not-leak" not in caught.value.detail


async def test_transcribe_rejects_invalid_json():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"not json")

    with pytest.raises(OpenRouterParseError, match="not valid JSON"):
        await transcribe_pdf(
            _client(handler), PDF, api_key="key", model="model", timeout_s=5
        )


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"choices": []},
        {"choices": [{}]},
        {"choices": [{"message": {}}]},
    ],
)
async def test_transcribe_rejects_missing_message_content(payload):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    with pytest.raises(OpenRouterParseError, match="missing message content"):
        await transcribe_pdf(
            _client(handler), PDF, api_key="key", model="model", timeout_s=5
        )


async def test_transcribe_rejects_incomplete_output():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {"content": "partial transcription..."},
                        "finish_reason": "length",
                    }
                ]
            },
        )

    with pytest.raises(
        OpenRouterParseError, match="incomplete: finish_reason=length"
    ):
        await transcribe_pdf(
            _client(handler), PDF, api_key="key", model="model", timeout_s=5
        )


async def test_transcribe_accepts_missing_finish_reason_for_compatibility():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"choices": [{"message": {"content": "complete text"}}]}
        )

    out = await transcribe_pdf(
        _client(handler), PDF, api_key="key", model="model", timeout_s=5
    )
    assert out == "complete text"


@pytest.mark.parametrize("content", ["   ", None, []])
async def test_transcribe_rejects_empty_or_non_string_content(content):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "choices": [
                    {"message": {"content": content}, "finish_reason": "stop"}
                ]
            },
        )

    with pytest.raises(OpenRouterParseError, match="empty transcription"):
        await transcribe_pdf(
            _client(handler), PDF, api_key="key", model="model", timeout_s=5
        )


def test_inline_cap_is_conservative_pending_live_boundary_proof():
    assert openrouter_pdf.OPENROUTER_INLINE_MAX_BYTES == 4 * 1024 * 1024


def test_prompt_is_a_transcription_instruction():
    assert "Transcribe" in openrouter_pdf.TRANSCRIBE_PROMPT
    assert "summarize" in openrouter_pdf.TRANSCRIBE_PROMPT.lower()

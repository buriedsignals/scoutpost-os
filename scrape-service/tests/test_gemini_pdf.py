import httpx
import pytest

from app import gemini_pdf
from app.gemini_pdf import GeminiParseError, transcribe_pdf
from tests.conftest import mock_http_client

PDF = b"%PDF-1.4 fake bytes"


def _client(handler):
    return mock_http_client(handler)


async def test_transcribe_returns_text():
    def handler(request: httpx.Request) -> httpx.Response:
        assert "generativelanguage" in request.url.host
        assert "key" not in request.url.query.decode()  # key must NOT be in URL
        assert request.headers.get("x-goog-api-key") == "g-key"  # header instead
        body = request.read().decode()
        assert "application/pdf" in body  # inline_data mime
        return httpx.Response(
            200,
            json={"candidates": [{"content": {"parts": [{"text": "# Doc\n\nbody"}]}}]},
        )

    out = await transcribe_pdf(_client(handler), PDF, api_key="g-key", model="m", timeout_s=5)
    assert out == "# Doc\n\nbody"


async def test_transcribe_http_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, json={"error": "rate limit"})

    with pytest.raises(GeminiParseError, match="HTTP 429"):
        await transcribe_pdf(_client(handler), PDF, api_key="k", model="m", timeout_s=5)


async def test_transcribe_timeout():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow")

    with pytest.raises(GeminiParseError, match="timed out"):
        await transcribe_pdf(_client(handler), PDF, api_key="k", model="m", timeout_s=0.01)


async def test_transcribe_network_error():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    with pytest.raises(GeminiParseError, match="failed"):
        await transcribe_pdf(_client(handler), PDF, api_key="k", model="m", timeout_s=5)


async def test_transcribe_missing_text_part():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"candidates": [{}]})

    with pytest.raises(GeminiParseError, match="missing text part"):
        await transcribe_pdf(_client(handler), PDF, api_key="k", model="m", timeout_s=5)


async def test_transcribe_rejects_truncated_output():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"candidates": [{
                "finishReason": "MAX_TOKENS",
                "content": {"parts": [{"text": "partial transcription..."}]},
            }]},
        )

    with pytest.raises(GeminiParseError, match="incomplete: finishReason=MAX_TOKENS"):
        await transcribe_pdf(_client(handler), PDF, api_key="k", model="m", timeout_s=5)


async def test_transcribe_accepts_explicit_stop():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"candidates": [{
                "finishReason": "STOP",
                "content": {"parts": [{"text": "complete text"}]},
            }]},
        )

    out = await transcribe_pdf(_client(handler), PDF, api_key="k", model="m", timeout_s=5)
    assert out == "complete text"


async def test_transcribe_empty_text():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"candidates": [{"content": {"parts": [{"text": "   "}]}}]}
        )

    with pytest.raises(GeminiParseError, match="empty transcription"):
        await transcribe_pdf(_client(handler), PDF, api_key="k", model="m", timeout_s=5)


def test_prompt_is_a_transcription_instruction():
    assert "Transcribe" in gemini_pdf.TRANSCRIBE_PROMPT
    assert "summarize" in gemini_pdf.TRANSCRIBE_PROMPT.lower()

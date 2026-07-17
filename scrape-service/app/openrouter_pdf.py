"""OpenRouter/Google Vertex native-PDF transcription fallback.

Used only when pdftotext's density guard trips (scanned / thin PDF). The PDF
is sent through OpenRouter to a ZDR Google Vertex route with the native PDF
engine forced explicitly. ``temperature=0`` minimizes run-to-run variance,
but the output is still not bit-deterministic, so this remains a fallback only
for documents that pdftotext cannot read.
"""

import base64

import httpx

OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions"

# Temporary fail-closed limit pending the U0 live OpenRouter/Vertex boundary
# probe. Four MiB raw expands to roughly 5.34 MiB as base64 before the JSON
# envelope. Keep this conservative and isolated here; raise it only when the
# live native-PDF route proves the larger boundary. Oversized scanned PDFs
# surface needs_ocr instead of falling back to a different parser/provider.
OPENROUTER_INLINE_MAX_BYTES = 4 * 1024 * 1024

TRANSCRIBE_PROMPT = (
    "Transcribe this document to clean Markdown. Preserve ALL text — headings, "
    "body paragraphs, tables (as Markdown tables), lists, figure and chart "
    "labels, and footnotes — in natural reading order. Do not summarize, "
    "omit, or add commentary. Output only the transcription."
)


class OpenRouterParseError(Exception):
    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


async def transcribe_pdf(
    client: httpx.AsyncClient,
    pdf_bytes: bytes,
    *,
    api_key: str,
    model: str,
    timeout_s: float,
) -> str:
    body = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "file",
                        "file": {
                            "filename": "document.pdf",
                            "file_data": (
                                "data:application/pdf;base64,"
                                + base64.b64encode(pdf_bytes).decode("ascii")
                            ),
                        }
                    },
                    {"type": "text", "text": TRANSCRIBE_PROMPT},
                ],
            }
        ],
        "temperature": 0,
        "provider": {
            "only": ["google-vertex"],
            "zdr": True,
            "data_collection": "deny",
            "require_parameters": True,
        },
        # OpenRouter otherwise chooses a parser automatically. Native is the
        # only permitted engine because it keeps PDF processing on the pinned
        # Google Vertex route; never add Mistral OCR or Cloudflare fallback.
        "plugins": [{"id": "file-parser", "pdf": {"engine": "native"}}],
    }
    try:
        res = await client.post(
            OPENROUTER_CHAT_COMPLETIONS_URL,
            json=body,
            headers={
                "Authorization": f"Bearer {api_key}",
                "X-OpenRouter-Cache": "false",
            },
            timeout=timeout_s,
        )
    except httpx.TimeoutException as e:
        raise OpenRouterParseError(
            f"openrouter transcribe timed out: {type(e).__name__}"
        ) from e
    except httpx.HTTPError as e:
        raise OpenRouterParseError(
            f"openrouter transcribe failed: {type(e).__name__}"
        ) from e
    if res.status_code >= 400:
        raise OpenRouterParseError(
            f"openrouter transcribe failed: HTTP {res.status_code}"
        )
    try:
        data = res.json()
    except ValueError as e:
        raise OpenRouterParseError("openrouter response was not valid JSON") from e
    try:
        choice = data["choices"][0]
        text = choice["message"]["content"]
    except (KeyError, IndexError, TypeError) as e:
        raise OpenRouterParseError("openrouter response missing message content") from e
    # A truncated transcription (output-token budget hit) must fail loudly, not
    # be stored as if the whole scanned document was captured.
    finish = choice.get("finish_reason")
    if finish not in (None, "stop"):
        raise OpenRouterParseError(
            f"openrouter transcription incomplete: finish_reason={finish}"
        )
    if not isinstance(text, str) or not text.strip():
        raise OpenRouterParseError("openrouter returned empty transcription")
    return text

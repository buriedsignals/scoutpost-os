"""Gemini native-PDF transcription — the low-yield fallback (U3d).

Used only when pdftotext's density guard trips (scanned / thin PDF). Gemini
2.x ingests the PDF bytes directly and transcribes to markdown. temperature=0
minimizes run-to-run variance, but the output is still not bit-deterministic —
acceptable ONLY as a fallback for documents that pdftotext cannot read at all
(the alternative is empty text and a hard failure). The deterministic
pdftotext path remains primary for the ~90%+ of civic PDFs with a real text
layer, keeping content_sha256 dedup stable there.
"""

import base64

import httpx

GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta"

# Gemini caps the TOTAL inline request at 20 MB. The PDF is base64-encoded
# (~4/3 inflation) and rides alongside the prompt + JSON envelope, so the raw
# PDF must stay well under 20 MB: 14 MB raw → ~18.7 MB encoded, leaving margin.
# A PDF larger than this can't be transcribed inline (the File API would be
# needed) — callers should skip the fallback and surface needs_ocr instead.
GEMINI_INLINE_MAX_BYTES = 14 * 1024 * 1024

TRANSCRIBE_PROMPT = (
    "Transcribe this document to clean Markdown. Preserve ALL text — headings, "
    "body paragraphs, tables (as Markdown tables), lists, figure and chart "
    "labels, and footnotes — in natural reading order. Do not summarize, "
    "omit, or add commentary. Output only the transcription."
)


class GeminiParseError(Exception):
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
        "contents": [
            {
                "parts": [
                    {
                        "inline_data": {
                            "mime_type": "application/pdf",
                            "data": base64.b64encode(pdf_bytes).decode("ascii"),
                        }
                    },
                    {"text": TRANSCRIBE_PROMPT},
                ]
            }
        ],
        "generationConfig": {"temperature": 0},
    }
    try:
        # Key in the x-goog-api-key header, NOT the URL query string — a
        # ?key=... URL leaks into httpx exception text, proxy/access logs, and
        # any error detail propagated upstream into scout_runs.
        res = await client.post(
            f"{GEMINI_BASE}/models/{model}:generateContent",
            json=body,
            headers={"x-goog-api-key": api_key},
            timeout=timeout_s,
        )
    except httpx.TimeoutException as e:
        raise GeminiParseError(f"gemini transcribe timed out: {e or type(e).__name__}") from e
    except httpx.HTTPError as e:
        raise GeminiParseError(f"gemini transcribe failed: {e or type(e).__name__}") from e
    if res.status_code >= 400:
        raise GeminiParseError(f"gemini transcribe failed: HTTP {res.status_code}")
    data = res.json()
    try:
        candidate = data["candidates"][0]
        text = candidate["content"]["parts"][0]["text"]
    except (KeyError, IndexError, TypeError) as e:
        raise GeminiParseError("gemini response missing text part") from e
    # A truncated transcription (output-token budget hit) must fail loudly, not
    # be stored as if the whole scanned document was captured.
    finish = candidate.get("finishReason")
    if finish not in (None, "STOP"):
        raise GeminiParseError(f"gemini transcription incomplete: finishReason={finish}")
    if not isinstance(text, str) or not text.strip():
        raise GeminiParseError("gemini returned empty transcription")
    return text

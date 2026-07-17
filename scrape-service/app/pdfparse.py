"""PDF → text via poppler pdftotext, with a text-density guard.

Parity note (SCRAPING-MIGRATION-PRD KTD4): production Firecrawl always ran
pdfMode:"fast" — embedded-text extraction, never OCR — so pdftotext -layout is
behavioral parity, not a downgrade. The density guard exists to *measure* the
scanned-document share: a bitmap-only PDF yields near-zero chars/page and
surfaces as a structured `needs_ocr` error instead of silently empty text.

Determinism matters: civic dedup keys on content_sha256 of this output, so the
parser must be reproducible (which is also why LLM transcription is excluded
as a primary parser).
"""

import asyncio
import ipaddress
import socket
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from urllib.parse import urlparse

import httpx


class PdfDownloadError(Exception):
    def __init__(self, detail: str, status_code: int | None = None) -> None:
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


class PdfTimeoutError(Exception):
    """Transient by contract: maps to 504 upstream (typed, not string-matched)."""

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


class PrivateAddressError(Exception):
    """The URL's host resolves to a loopback/private/link-local address."""


class PdfTooLargeError(Exception):
    pass


class NotAPdfError(Exception):
    pass


class NeedsOcrError(Exception):
    def __init__(self, pages: int, chars: int) -> None:
        super().__init__(f"needs_ocr: {chars} chars over {pages} pages")
        self.pages = pages
        self.chars = chars


@dataclass(frozen=True)
class ParsedPdf:
    text: str
    pages: int
    chars: int
    parser: str = "pdftotext"


def assert_public_host(url: str) -> None:
    """Defense-in-depth against SSRF via the download path: only fetch http(s)
    URLs whose host resolves to a public address. Refuses non-http(s) schemes
    (file://, gopher://, …) and hosts on loopback/private/link-local/metadata
    ranges. Not airtight (DNS rebinding), but it removes the trivial
    internal-target cases; the bearer token remains the primary control.

    Called before EVERY hop in download_pdf — a public URL that 30x-redirects
    to http://169.254.169.254/ (cloud metadata) or file:///etc/passwd must be
    caught at the redirect target, not just the initial URL."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        # A non-http(s) redirect target is an SSRF vector; block it like a
        # private address (both map to a 422 "blocked" upstream).
        raise PrivateAddressError()
    host = parsed.hostname or ""
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError as e:
        raise PdfDownloadError(f"download failed: cannot resolve {host}: {e}") from e
    for info in infos:
        address = ipaddress.ip_address(info[4][0])
        if (
            address.is_private
            or address.is_loopback
            or address.is_link_local
            or address.is_reserved
            or address.is_multicast
        ):
            raise PrivateAddressError()


# Redirects are followed MANUALLY (not httpx follow_redirects=True) so the SSRF
# guard runs against every hop. Bounded low — a civic PDF behind >5 hops is
# pathological.
MAX_PDF_REDIRECTS = 5


async def download_pdf(
    client: httpx.AsyncClient,
    url: str,
    *,
    timeout_s: float,
    max_bytes: int,
) -> bytes:
    # Streamed so the size cap bounds memory: a multi-GB (or drip-fed) body is
    # aborted as soon as the accumulated bytes exceed max_bytes, never buffered.
    current = url
    for _ in range(MAX_PDF_REDIRECTS + 1):
        # Re-validate BEFORE connecting to each hop — the whole point of manual
        # redirect handling is that the guard sees the redirect target.
        assert_public_host(current)
        chunks: list[bytes] = []
        received = 0
        try:
            async with client.stream(
                "GET", current, timeout=timeout_s, follow_redirects=False
            ) as response:
                # Detect redirects by status code (not response.is_redirect,
                # which additionally requires a Location header) so a malformed
                # redirect surfaces as an explicit error rather than a body read.
                if response.status_code in (301, 302, 303, 307, 308):
                    location = response.headers.get("location")
                    if not location:
                        raise PdfDownloadError("download failed: redirect without Location")
                    # Resolve relative Location against the current URL, then
                    # loop back to re-validate the resolved target.
                    current = str(response.url.join(location))
                    continue
                if response.status_code >= 400:
                    raise PdfDownloadError(
                        f"download failed: HTTP {response.status_code}",
                        status_code=response.status_code,
                    )
                async for chunk in response.aiter_bytes():
                    received += len(chunk)
                    if received > max_bytes:
                        raise PdfTooLargeError()
                    chunks.append(chunk)
        except httpx.TimeoutException as e:
            raise PdfTimeoutError(f"download timed out: {e or type(e).__name__}") from e
        except httpx.HTTPError as e:
            raise PdfDownloadError(f"download failed: {e or type(e).__name__}") from e
        body = b"".join(chunks)
        if not body.startswith(b"%PDF"):
            raise NotAPdfError()
        return body
    raise PdfDownloadError(f"download failed: exceeded {MAX_PDF_REDIRECTS} redirects")


def count_pages_from_text(text: str) -> int:
    # pdftotext emits one form-feed per page (including the last). This is the
    # correct denominator even for PDF 1.5+ compressed object streams, where a
    # byte-level /Type /Page scan finds nothing.
    return max(1, text.count("\f"))


async def run_pdftotext(pdf_bytes: bytes, *, timeout_s: float = 30.0) -> str:
    process = await asyncio.create_subprocess_exec(
        "pdftotext",
        "-layout",
        "-q",
        "-",
        "-",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(
            process.communicate(pdf_bytes), timeout=timeout_s
        )
    except asyncio.TimeoutError as e:
        process.kill()
        raise PdfTimeoutError("pdftotext timed out") from e
    if process.returncode != 0:
        detail = stderr.decode("utf-8", "replace").strip() or "pdftotext failed"
        raise PdfDownloadError(f"pdftotext exited {process.returncode}: {detail}")
    return stdout.decode("utf-8", "replace")


async def parse_pdf_url(
    client: httpx.AsyncClient,
    url: str,
    *,
    timeout_s: float,
    max_bytes: int,
    min_chars_per_page: int,
    transcribe: "Callable[[bytes], Awaitable[str]] | None" = None,
    transcribe_max_bytes: int | None = None,
) -> ParsedPdf:
    pdf_bytes = await download_pdf(
        client, url, timeout_s=timeout_s, max_bytes=max_bytes
    )
    text = await run_pdftotext(pdf_bytes)
    pages = count_pages_from_text(text)
    chars = len(text.strip())
    if chars < min_chars_per_page * pages:
        # Low yield (scanned / thin): if an OpenRouter transcriber is wired,
        # use it instead of failing. Non-deterministic, so only for PDFs pdftotext
        # can't read — the deterministic path stays primary elsewhere (U3d).
        # A PDF too large for the proven inline request limit CANNOT be
        # transcribed this way; skip the fallback and surface needs_ocr rather
        # than firing an OpenRouter request that would be rejected with a 4xx.
        too_large_for_inline = (
            transcribe_max_bytes is not None and len(pdf_bytes) > transcribe_max_bytes
        )
        if transcribe is not None and not too_large_for_inline:
            transcribed_text = await transcribe(pdf_bytes)
            return ParsedPdf(
                text=transcribed_text,
                pages=pages,
                chars=len(transcribed_text.strip()),
                parser="openrouter",
            )
        raise NeedsOcrError(pages=pages, chars=chars)
    return ParsedPdf(text=text, pages=pages, chars=chars, parser="pdftotext")

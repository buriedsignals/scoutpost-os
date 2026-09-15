"""Transport-neutral crawl execution shared by HTTP and Workflow tasks."""

import asyncio
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

import httpx

from .config import Settings
from .mapping import crawl_failure_detail, map_crawl_result, map_pdf_scrape_result
from .network_policy import UnsafeDestinationError, validate_http_target
from .openrouter_pdf import OPENROUTER_INLINE_MAX_BYTES, transcribe_pdf
from .pdfparse import (
    InvalidPdfError,
    NeedsOcrError,
    NotAPdfError,
    ParsedPdf,
    PdfDownloadError,
    PdfTooLargeError,
    PdfTimeoutError,
    PrivateAddressError,
    UnresolvableHostError,
    assert_public_host,
    parse_pdf_url,
)
from .scraper import Scraper
from .snapshots import build_snapshot_payload, scrape_fuse_seconds


@dataclass(frozen=True)
class CrawlItem:
    id: str
    operation: str
    url: str
    timeout_ms: int = 25_000


class CrawlResultError(RuntimeError):
    """Crawl4AI returned a completed but unsuccessful result."""


class DownloadResponseError(RuntimeError):
    """A browser download cannot satisfy this operation; do not navigate again."""

    def __init__(self, message: str, status_code: int = 422) -> None:
        super().__init__(message)
        self.status_code = status_code


def is_download_signal(error: object) -> bool:
    return "download is starting" in str(error).lower()


async def execute_crawl(
    scraper: Scraper,
    url: str,
    *,
    timeout_ms: int,
    snapshot: bool,
    pdf_client: httpx.AsyncClient | None = None,
    settings: Settings | None = None,
) -> dict[str, Any]:
    """Run one browser navigation, or inspect its download using the PDF guard."""
    started = time.monotonic()
    try:
        raw = await asyncio.wait_for(
            scraper.run(url, timeout_ms=timeout_ms, snapshot=snapshot),
            timeout=scrape_fuse_seconds(timeout_ms, snapshot),
        )
        if not getattr(raw, "success", False):
            raise CrawlResultError(crawl_failure_detail(raw))
    except Exception as exc:  # Crawl4AI may raise or return a failed result.
        if not is_download_signal(exc):
            raise
        if snapshot:
            raise DownloadResponseError(
                "document_download_snapshot_unsupported: no HTML archive was captured"
            ) from exc
        if pdf_client is None or settings is None:
            raise DownloadResponseError(
                "document_download_parser_unavailable: PDF inspection requires a configured runner"
            ) from exc
        remaining = timeout_ms / 1_000 - (time.monotonic() - started)
        if remaining <= 0:
            raise DownloadResponseError(
                "document_download_timeout: inspection deadline exhausted", 504
            ) from exc
        try:
            parsed = await asyncio.wait_for(
                _parse_pdf(pdf_client, settings, url, remaining),
                timeout=remaining,
            )
        except (asyncio.TimeoutError, PdfTimeoutError) as timeout_error:
            raise DownloadResponseError(
                f"document_download_timeout: {timeout_error or 'inspection deadline exhausted'}", 504
            ) from timeout_error
        except PdfDownloadError as download_error:
            # Once navigation has proved this is a download, repeating browser
            # retries cannot repair an invalid document or redirect chain.
            raise DownloadResponseError(
                f"document_download_failed: {download_error}"
            ) from download_error
        return map_pdf_scrape_result(parsed, requested_url=url)
    # Projection parses HTML and runs a second Markdown conversion; keep that
    # CPU-bound work off the FastAPI event loop while other crawls progress.
    result = await asyncio.to_thread(map_crawl_result, raw, requested_url=url)
    if snapshot:
        try:
            payload, error = await asyncio.to_thread(build_snapshot_payload, raw)
        except Exception as exc:  # Snapshot loss must not discard valid markdown.
            payload, error = None, f"payload_assembly_failed:{exc.__class__.__name__}"
        if payload is not None:
            result["snapshot"] = payload
        else:
            result["snapshot_error"] = error
    return result


async def run_item(
    scraper: Scraper,
    item: CrawlItem,
    *,
    pdf_client: httpx.AsyncClient | None = None,
    settings: Settings | None = None,
) -> dict[str, Any]:
    """Run one item using the same mapping and taxonomy as the web service."""
    validate_http_target(item.url)
    await asyncio.to_thread(assert_public_host, item.url)
    if item.operation == "parse_pdf":
        if pdf_client is None or settings is None:
            return _failure(item.id, "terminal", "PDF runner is unavailable")
        return await _run_pdf(pdf_client, settings, item)
    if item.operation not in {"scrape", "snapshot"}:
        return _failure(item.id, "terminal", "unsupported operation")

    snapshot = item.operation == "snapshot"
    try:
        result = await execute_crawl(
            scraper,
            item.url,
            timeout_ms=item.timeout_ms,
            snapshot=snapshot,
            pdf_client=pdf_client,
            settings=settings,
        )
    except asyncio.TimeoutError:
        return _failure(item.id, "timeout", "crawl timed out")
    except Exception as exc:  # noqa: BLE001 - Crawl4AI has no stable exception base.
        return classify_failure(item.id, exc)
    if (
        result.get("status_code") in (403, 429)
        and not result.get("markdown", "").strip()
    ):
        return _failure(item.id, "anti_bot", "empty challenge result")
    await asyncio.to_thread(assert_public_host, result["source_url"])
    return {"id": item.id, "ok": True, "result": result}


async def _run_pdf(
    client: httpx.AsyncClient, settings: Settings, item: CrawlItem
) -> dict[str, Any]:
    parsed = await _parse_pdf(client, settings, item.url, item.timeout_ms / 1_000)
    return {
        "id": item.id,
        "ok": True,
        "result": {
            "markdown": parsed.text,
            "pages": parsed.pages,
            "chars": parsed.chars,
            "parser": parsed.parser,
            "source_url": item.url,
        },
    }


async def _parse_pdf(
    client: httpx.AsyncClient, settings: Settings, url: str, timeout_s: float
) -> ParsedPdf:
    transcribe: Callable[[bytes], Awaitable[str]] | None = None
    if settings.openrouter_api_key:

        async def transcribe(pdf_bytes: bytes) -> str:
            return await transcribe_pdf(
                client,
                pdf_bytes,
                api_key=settings.openrouter_api_key or "",
                model=settings.openrouter_model,
                timeout_s=settings.openrouter_timeout_s,
            )

    return await parse_pdf_url(
        client,
        url,
        timeout_s=min(timeout_s, settings.parse_download_timeout_s),
        max_bytes=settings.parse_max_pdf_bytes,
        min_chars_per_page=settings.parse_min_chars_per_page,
        transcribe=transcribe,
        transcribe_max_bytes=OPENROUTER_INLINE_MAX_BYTES,
    )


def _failure(item_id: str, error_class: str, error: str) -> dict[str, Any]:
    return {
        "id": item_id,
        "ok": False,
        "error_class": error_class,
        "error": error[:1_500],
    }


def classify_failure(item_id: str, error: object) -> dict[str, Any]:
    message = str(error)[:1_500]
    if isinstance(error, NotAPdfError):
        message = "not_a_pdf"
    elif isinstance(error, PdfTooLargeError):
        message = "pdf_too_large"
    elif isinstance(error, PrivateAddressError):
        message = "private_address"
    lowered = message.lower()
    # A host DNS cannot resolve is permanent: retrying spends the whole budget
    # on three guaranteed failures. Most often a user pasting a docs
    # placeholder, so it must not look like a crawler fault either.
    if isinstance(
        error,
        (
            DownloadResponseError,
            InvalidPdfError,
            PrivateAddressError,
            UnsafeDestinationError,
            NeedsOcrError,
            NotAPdfError,
            PdfTooLargeError,
            UnresolvableHostError,
        ),
    ):
        error_class = "terminal"
    elif is_download_signal(error):
        error_class = "terminal"
    # Patchright reports this exact Chromium network code when a target closes
    # the browser connection without a response. Keep the match narrow: the
    # Firecrawl fallback recovered every occurrence in the Page canary, while
    # ordinary network failures should retain the normal retry path.
    elif "net::err_empty_response" in lowered:
        error_class = "anti_bot"
    elif re.search(r"\bstatus 5\d\d\b", lowered):
        error_class = "retryable"
    elif any(word in lowered for word in ("anti-bot", "captcha", "challenge")):
        error_class = "anti_bot"
    elif any(word in lowered for word in ("timeout", "timed out")):
        error_class = "timeout"
    else:
        error_class = "retryable"
    return _failure(item_id, error_class, message or "crawl failed")


async def run_item_safely(
    scraper: Scraper,
    item: CrawlItem,
    *,
    pdf_client: httpx.AsyncClient | None = None,
    settings: Settings | None = None,
) -> dict[str, Any]:
    """Keep one failed page from replaying the completed prefix of its batch."""
    try:
        outcome = await run_item(
            scraper,
            item,
            pdf_client=pdf_client,
            settings=settings,
        )
    except Exception as exc:  # noqa: BLE001 - the batch isolates every item failure.
        outcome = classify_failure(item.id, exc)
    return outcome

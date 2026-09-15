import asyncio
import threading
from types import SimpleNamespace

import pytest
import httpx
from app import crawl_runner
from app.crawl_runner import CrawlItem, classify_failure, run_item_safely
from app.network_policy import UnsafeDestinationError
from app.pdfparse import (
    NotAPdfError,
    PdfDownloadError,
    PdfTooLargeError,
    PrivateAddressError,
    UnresolvableHostError,
)

from tests.conftest import (
    EMPTY_PDF,
    TEXT_PDF,
    FakeScraper as RecordingScraper,
    make_settings,
    mock_http_client,
)


class FakeScraper:
    def __init__(self, result=None, error=None):
        self.result = result
        self.error = error

    async def run(self, _url, **_kwargs):
        if self.error:
            raise self.error
        return self.result


async def test_runner_maps_success(monkeypatch):
    monkeypatch.setattr("app.crawl_runner.assert_public_host", lambda _url: None)
    raw = SimpleNamespace(
        success=True,
        markdown="hello",
        html="<p>hello</p>",
        url="https://example.org",
        status_code=200,
    )
    outcome = await run_item_safely(
        FakeScraper(result=raw),
        CrawlItem(id="a", operation="scrape", url="https://example.org"),
    )
    assert outcome["ok"] is True
    assert outcome["result"]["markdown"] == "hello"


async def test_execute_crawl_projects_mapping_off_the_event_loop(monkeypatch):
    raw = SimpleNamespace(success=True)
    mapped_on = []

    def blocking_projection(_raw, *, requested_url):
        mapped_on.append(threading.current_thread())
        return {"source_url": requested_url, "markdown": "projected"}

    monkeypatch.setattr(crawl_runner, "map_crawl_result", blocking_projection)
    result = await crawl_runner.execute_crawl(
        FakeScraper(result=raw),
        "https://example.org",
        timeout_ms=1_000,
        snapshot=False,
    )

    assert result["markdown"] == "projected"
    assert mapped_on[0] is not threading.current_thread()


async def test_runner_classifies_timeout_and_scraper_error(monkeypatch):
    monkeypatch.setattr("app.crawl_runner.assert_public_host", lambda _url: None)
    timeout = await run_item_safely(
        FakeScraper(error=asyncio.TimeoutError()),
        CrawlItem(id="a", operation="scrape", url="https://example.org"),
    )
    assert timeout["error_class"] == "timeout"
    failed = await run_item_safely(
        FakeScraper(error=RuntimeError("upstream")),
        CrawlItem(id="a", operation="scrape", url="https://example.org"),
    )
    assert failed["error_class"] == "retryable"


async def test_runner_maps_snapshot_and_challenge(monkeypatch):
    monkeypatch.setattr("app.crawl_runner.assert_public_host", lambda _url: None)
    raw = SimpleNamespace(
        success=True,
        markdown="hello",
        html="<p>hello</p>",
        url="https://example.org",
        status_code=200,
    )
    monkeypatch.setattr(
        "app.crawl_runner.build_snapshot_payload", lambda _raw: ({"mhtml": "x"}, None)
    )
    outcome = await run_item_safely(
        FakeScraper(result=raw),
        CrawlItem(id="snapshot", operation="snapshot", url="https://example.org"),
    )
    assert "snapshot" in outcome["result"]

    raw.markdown = ""
    raw.status_code = 403
    blocked = await run_item_safely(
        FakeScraper(result=raw),
        CrawlItem(id="blocked", operation="scrape", url="https://example.org"),
    )
    assert blocked["error_class"] == "anti_bot"


async def test_runner_maps_pdf(monkeypatch):
    monkeypatch.setattr("app.crawl_runner.assert_public_host", lambda _url: None)
    parsed = SimpleNamespace(text="minutes", pages=2, chars=7, parser="pdftotext")

    async def fake_parse(*_args, **_kwargs):
        return parsed

    monkeypatch.setattr(crawl_runner, "parse_pdf_url", fake_parse)
    result = await run_item_safely(
        FakeScraper(),
        CrawlItem(id="pdf", operation="parse_pdf", url="https://example.org/a.pdf"),
        pdf_client=object(),
        settings=make_settings(),
    )
    assert result["result"]["parser"] == "pdftotext"


async def test_pdf_runner_requires_dependencies(monkeypatch):
    monkeypatch.setattr("app.crawl_runner.assert_public_host", lambda _url: None)
    result = await run_item_safely(
        FakeScraper(),
        CrawlItem(id="pdf", operation="parse_pdf", url="https://example.org/a.pdf"),
    )
    assert result["error_class"] == "terminal"


async def test_pdf_runner_configures_openrouter_fallback(monkeypatch):
    monkeypatch.setattr("app.crawl_runner.assert_public_host", lambda _url: None)
    observed = {}

    async def fake_transcribe(_client, pdf_bytes, **kwargs):
        observed.update(kwargs)
        assert pdf_bytes == b"pdf"
        return "ocr"

    async def fake_parse(*_args, **kwargs):
        assert await kwargs["transcribe"](b"pdf") == "ocr"
        return SimpleNamespace(text="minutes", pages=1, chars=7, parser="openrouter")

    monkeypatch.setattr(crawl_runner, "transcribe_pdf", fake_transcribe)
    monkeypatch.setattr(crawl_runner, "parse_pdf_url", fake_parse)
    settings = make_settings(openrouter_api_key="key")
    result = await run_item_safely(
        FakeScraper(),
        CrawlItem(id="pdf", operation="parse_pdf", url="https://example.org/a.pdf"),
        pdf_client=object(),
        settings=settings,
    )
    assert result["ok"] is True
    assert observed["api_key"] == "key"


async def test_runner_maps_unsuccessful_and_snapshot_error(monkeypatch):
    monkeypatch.setattr("app.crawl_runner.assert_public_host", lambda _url: None)
    failed = await run_item_safely(
        FakeScraper(result=SimpleNamespace(success=False, error_message="upstream")),
        CrawlItem(id="failed", operation="scrape", url="https://example.org"),
    )
    assert failed["error_class"] == "retryable"

    raw = SimpleNamespace(
        success=True,
        markdown="hello",
        html="<p>hello</p>",
        url="https://example.org",
        status_code=200,
    )
    monkeypatch.setattr(
        "app.crawl_runner.build_snapshot_payload", lambda _raw: (None, "missing")
    )
    result = await run_item_safely(
        FakeScraper(result=raw),
        CrawlItem(id="snapshot", operation="snapshot", url="https://example.org"),
    )
    assert result["result"]["snapshot_error"] == "missing"


async def test_safe_wrapper_contains_guard_failure(monkeypatch):
    async def fail(*_args, **_kwargs):
        raise PrivateAddressError("private")

    monkeypatch.setattr(crawl_runner, "run_item", fail)
    outcome = await run_item_safely(
        FakeScraper(),
        CrawlItem(id="guarded", operation="scrape", url="https://example.org"),
    )
    assert outcome["error_class"] == "terminal"


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (PrivateAddressError(), "terminal"),
        (UnsafeDestinationError(), "terminal"),
        (RuntimeError("status 502; Blocked by anti-bot protection"), "retryable"),
        (
            RuntimeError(
                "Page.goto: net::ERR_EMPTY_RESPONSE at https://example.org"
            ),
            "anti_bot",
        ),
        (RuntimeError("Page.goto: net::ERR_CONNECTION_RESET"), "retryable"),
        (RuntimeError("captcha"), "anti_bot"),
        (RuntimeError("timed out"), "timeout"),
        (RuntimeError("upstream"), "retryable"),
        # DNS has no address for the host: permanent, terminal on attempt 1.
        (
            UnresolvableHostError(
                "download failed: cannot resolve your_council_domain.gov: "
                "[Errno -5] No address associated with hostname"
            ),
            "terminal",
        ),
        # A plain PdfDownloadError is still ordinary and stays retryable.
        (PdfDownloadError("download failed: status 503"), "retryable"),
        (RuntimeError("Page.goto: Download is starting"), "terminal"),
    ],
)
def test_classify_failure(error, expected):
    assert classify_failure("a", error)["error_class"] == expected


@pytest.mark.parametrize(
    ("error", "message"),
    [
        (NotAPdfError(), "not_a_pdf"),
        (PdfTooLargeError(), "pdf_too_large"),
        (PrivateAddressError(), "private_address"),
    ],
)
def test_classify_failure_preserves_proxy_compatibility_sentinels(error, message):
    assert classify_failure("a", error)["error"] == message


async def test_runner_rejects_unknown_operation(monkeypatch):
    monkeypatch.setattr("app.crawl_runner.assert_public_host", lambda _url: None)
    outcome = await run_item_safely(
        FakeScraper(), CrawlItem(id="a", operation="unknown", url="https://example.org")
    )
    assert outcome["error_class"] == "terminal"


async def test_scanned_pdf_without_credential_is_actionable_terminal_failure():
    import httpx
    from tests.conftest import EMPTY_PDF, mock_http_client

    async with mock_http_client(lambda _request: httpx.Response(200, content=EMPTY_PDF)) as client:
        outcome = await run_item_safely(
            FakeScraper(),
            CrawlItem(id="scanned", operation="parse_pdf", url="https://example.org/scanned.pdf"),
            pdf_client=client,
            settings=make_settings(),
        )
    assert outcome["ok"] is False
    assert outcome["error_class"] == "terminal"
    assert "ocr_not_configured" in outcome["error"]
    assert "OPENROUTER_API_KEY" in outcome["error"]


@pytest.mark.parametrize("returned_failure", [False, True])
@pytest.mark.parametrize("content_type", ["application/pdf", "application/octet-stream"])
async def test_download_signal_parses_extensionless_pdf_once(
    monkeypatch, returned_failure, content_type
):
    message = "Page.goto: Download is starting"
    scraper = RecordingScraper(
        result=SimpleNamespace(success=False, error_message=message)
        if returned_failure else None,
        exc=None if returned_failure else RuntimeError(message),
    )
    fetched = []

    def handler(request):
        fetched.append(str(request.url))
        if request.url.path == "/download":
            return httpx.Response(302, headers={"location": "/document"})
        return httpx.Response(
            200,
            content=TEXT_PDF,
            headers={"content-type": content_type, "content-disposition": "attachment"},
        )

    async with mock_http_client(handler) as client:
        outcome = await run_item_safely(
            scraper,
            CrawlItem(id="doc", operation="scrape", url="https://example.org/download"),
            pdf_client=client,
            settings=make_settings(),
        )
    assert outcome["ok"] is True
    result = outcome["result"]
    assert "Council meeting minutes, agenda item 1" in result["markdown"]
    assert result["source_url"] == "https://example.org/document"
    assert result["requested_url"] == "https://example.org/download"
    assert result["status_code"] == 200
    assert result["response_headers"]["content-type"] == content_type
    assert result["rawHtml"] is None and result["html"] is None
    assert result["comparison_strategy"] == "full"
    assert result["metadata"]["document"]["parser"] == "pdftotext"
    assert result["metadata"]["document"]["pages"] == 1
    assert len(scraper.calls) == 1
    assert fetched == ["https://example.org/download", "https://example.org/document"]


@pytest.mark.parametrize(
    ("body", "max_bytes", "expected"),
    [
        (b"MZ executable", 1000, "not_a_pdf"),
        (TEXT_PDF, 10, "pdf_too_large"),
        (b"%PDF-1.4 malformed", 1000, "pdftotext exited"),
        (EMPTY_PDF, 10000, "ocr_not_configured"),
    ],
)
async def test_invalid_download_is_terminal_without_browser_replay(body, max_bytes, expected):
    scraper = RecordingScraper(exc=RuntimeError("Page.goto: Download is starting"))
    async with mock_http_client(
        # A dishonest MIME must not bypass signature/structural validation.
        lambda _request: httpx.Response(200, content=body, headers={"content-type": "application/pdf"})
    ) as client:
        outcome = await run_item_safely(
            scraper,
            CrawlItem(id="bad", operation="scrape", url="https://example.org/download"),
            pdf_client=client,
            settings=make_settings(parse_max_pdf_bytes=max_bytes),
        )
    assert outcome["ok"] is False
    assert outcome["error_class"] == "terminal"
    assert expected in outcome["error"]
    assert len(scraper.calls) == 1


@pytest.mark.parametrize("location", ["http://169.254.169.254/latest/meta-data/", "file:///etc/passwd"])
async def test_download_rejects_unsafe_redirect_before_fetch(monkeypatch, location):
    from app import pdfparse

    monkeypatch.setattr(
        pdfparse.socket, "getaddrinfo",
        lambda host, port: [(2, 1, 6, "", (
            "169.254.169.254" if host == "169.254.169.254" else "93.184.216.34", 0
        ))],
    )
    fetched = []

    def handler(request):
        fetched.append(str(request.url))
        return httpx.Response(302, headers={"location": location})

    scraper = RecordingScraper(exc=RuntimeError("Page.goto: Download is starting"))
    async with mock_http_client(handler) as client:
        outcome = await run_item_safely(
            scraper,
            CrawlItem(id="unsafe", operation="scrape", url="https://example.org/download"),
            pdf_client=client,
            settings=make_settings(),
        )
    assert outcome["error_class"] == "terminal"
    assert outcome["error"] == "private_address"
    assert fetched == ["https://example.org/download"]


@pytest.mark.parametrize("headers", [{}, {"location": "/download"}])
async def test_download_invalid_redirect_chain_is_terminal(headers):
    scraper = RecordingScraper(exc=RuntimeError("Page.goto: Download is starting"))
    async with mock_http_client(lambda _request: httpx.Response(302, headers=headers)) as client:
        outcome = await run_item_safely(
            scraper,
            CrawlItem(id="loop", operation="scrape", url="https://example.org/download"),
            pdf_client=client,
            settings=make_settings(),
        )
    assert outcome["error_class"] == "terminal"
    assert "redirect" in outcome["error"]
    assert len(scraper.calls) == 1


@pytest.mark.parametrize(
    ("operation", "expected"),
    [("snapshot", "snapshot_unsupported"), ("scrape", "parser_unavailable")],
)
async def test_download_does_not_fake_archive_or_success_without_parser(operation, expected):
    scraper = RecordingScraper(exc=RuntimeError("Page.goto: Download is starting"))
    outcome = await run_item_safely(
        scraper,
        CrawlItem(id="unavailable", operation=operation, url="https://example.org/download"),
    )
    assert outcome["error_class"] == "terminal"
    assert expected in outcome["error"]
    assert len(scraper.calls) == 1


async def test_download_uses_remaining_deadline_and_cancels_parser(monkeypatch):
    parsing = asyncio.Event()
    cancelled = asyncio.Event()

    async def parse(*_args, **_kwargs):
        parsing.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    monkeypatch.setattr(crawl_runner, "_parse_pdf", parse)
    scraper = RecordingScraper(exc=RuntimeError("Page.goto: Download is starting"))
    outcome = await run_item_safely(
        scraper,
        CrawlItem(id="slow", operation="scrape", url="https://example.org/download", timeout_ms=100),
        pdf_client=object(),
        settings=make_settings(),
    )
    assert parsing.is_set() and cancelled.is_set()
    assert outcome["error_class"] == "terminal"
    assert "document_download_timeout" in outcome["error"]
    assert len(scraper.calls) == 1


async def test_download_preserves_scanned_pdf_ocr(monkeypatch):
    calls = []

    async def transcribe(_client, body, **_kwargs):
        calls.append(body)
        return "Transcribed council minutes."

    monkeypatch.setattr(crawl_runner, "transcribe_pdf", transcribe)
    scraper = RecordingScraper(exc=RuntimeError("Page.goto: Download is starting"))
    async with mock_http_client(lambda _request: httpx.Response(200, content=EMPTY_PDF)) as client:
        outcome = await run_item_safely(
            scraper,
            CrawlItem(id="scan", operation="scrape", url="https://example.org/download"),
            pdf_client=client,
            settings=make_settings(openrouter_api_key="fixture-key"),
        )
    assert outcome["result"]["markdown"] == "Transcribed council minutes."
    assert outcome["result"]["metadata"]["document"]["parser"] == "openrouter"
    assert calls == [EMPTY_PDF]


async def test_download_after_deadline_does_not_start_document_work(monkeypatch):
    ticks = iter((10.0, 11.0))
    monkeypatch.setattr(crawl_runner, "time", SimpleNamespace(monotonic=lambda: next(ticks)))

    def unexpected(_request):
        raise AssertionError("deadline exhausted before inspection")

    scraper = RecordingScraper(exc=RuntimeError("Page.goto: Download is starting"))
    async with mock_http_client(unexpected) as client:
        outcome = await run_item_safely(
            scraper,
            CrawlItem(id="expired", operation="scrape", url="https://example.org/download", timeout_ms=1000),
            pdf_client=client,
            settings=make_settings(),
        )
    assert outcome["error_class"] == "terminal"
    assert "document_download_timeout" in outcome["error"]
    assert len(scraper.calls) == 1


async def test_download_http_error_is_actionable_without_browser_retry():
    scraper = RecordingScraper(exc=RuntimeError("Page.goto: Download is starting"))
    async with mock_http_client(lambda _request: httpx.Response(404)) as client:
        outcome = await run_item_safely(
            scraper,
            CrawlItem(id="gone", operation="scrape", url="https://example.org/download"),
            pdf_client=client,
            settings=make_settings(),
        )
    assert outcome["error_class"] == "terminal"
    assert "HTTP 404" in outcome["error"]
    assert len(scraper.calls) == 1

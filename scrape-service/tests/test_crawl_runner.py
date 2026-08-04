import asyncio
from types import SimpleNamespace

import pytest
from app import crawl_runner
from app.crawl_runner import CrawlItem, classify_failure, run_item_safely
from app.network_policy import UnsafeDestinationError
from app.pdfparse import PrivateAddressError

from tests.conftest import make_settings


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
        (RuntimeError("captcha"), "anti_bot"),
        (RuntimeError("timed out"), "timeout"),
        (RuntimeError("upstream"), "retryable"),
    ],
)
def test_classify_failure(error, expected):
    assert classify_failure("a", error)["error_class"] == expected


async def test_runner_rejects_unknown_operation(monkeypatch):
    monkeypatch.setattr("app.crawl_runner.assert_public_host", lambda _url: None)
    outcome = await run_item_safely(
        FakeScraper(), CrawlItem(id="a", operation="unknown", url="https://example.org")
    )
    assert outcome["error_class"] == "terminal"

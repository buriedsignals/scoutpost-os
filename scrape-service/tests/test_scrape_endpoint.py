import asyncio
import json
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

from app import main, pdfparse
from app.main import create_app
from app.scraper import Scraper
from tests.conftest import FakeScraper, auth_headers, crawl_result, make_settings


def test_scrape_happy_path(app):
    fake = FakeScraper(result=crawl_result())
    app.state.scraper = fake
    res = TestClient(app).post(
        "/scrape", json={"url": "https://example.org"}, headers=auth_headers()
    )
    assert res.status_code == 200
    body = res.json()
    assert body["markdown"] == "# Heading\n\nBody text."
    assert body["requested_url"] == "https://example.org"
    # default timeout from settings is forwarded to the scraper
    assert fake.calls == [("https://example.org", 25_000)]


def test_library_navigation_timeout_keeps_the_retryable_http_code(app):
    app.state.scraper = FakeScraper(exc=RuntimeError("Page.goto: Timeout 25000ms exceeded"))
    response = TestClient(app).post(
        "/scrape", json={"url": "https://example.org"}, headers=auth_headers()
    )
    assert response.status_code == 504
    assert response.json()["detail"]["error"] == "navigation_timeout"


def test_scrape_download_returns_scrape_schema_and_parse_retains_parse_schema(app):
    from tests.conftest import TEXT_PDF, mock_http_client

    app.state.scraper = FakeScraper(exc=RuntimeError("Page.goto: Download is starting"))
    app.state.http_client = mock_http_client(
        lambda _request: httpx.Response(
            200, content=TEXT_PDF, headers={"content-type": "application/octet-stream"}
        )
    )
    client = TestClient(app)
    scrape = client.post(
        "/scrape", json={"url": "https://example.org/download"}, headers=auth_headers()
    )
    parse = client.post(
        "/parse", json={"url": "https://example.org/download"}, headers=auth_headers()
    )
    assert scrape.status_code == 200 and parse.status_code == 200
    scraped, parsed = scrape.json(), parse.json()
    assert "Council meeting minutes" in scraped["markdown"]
    assert scraped["markdown"] == parsed["markdown"]
    assert scraped["metadata"]["document"]["pages"] == parsed["pages"]
    assert scraped["rawHtml"] is None and scraped["html"] is None
    assert scraped["requested_url"] == "https://example.org/download"
    assert set(parsed) == {"markdown", "pages", "chars", "parser", "source_url"}
    assert len(app.state.scraper.calls) == 1


@pytest.mark.parametrize(
    ("document", "settings", "status", "error"),
    [
        ("unsupported", {}, 415, "not_a_pdf"),
        ("oversized", {"parse_max_pdf_bytes": 10}, 413, "pdf_too_large"),
        ("scanned", {}, 422, "needs_ocr"),
        ("malformed", {}, 422, "document_download_failed"),
        ("timeout", {}, 504, "download timed out"),
    ],
)
def test_scrape_download_errors_keep_actionable_http_statuses(document, settings, status, error):
    from tests.conftest import EMPTY_PDF, TEXT_PDF, mock_http_client

    def handler(_request):
        if document == "timeout":
            raise httpx.ReadTimeout("timed out")
        return httpx.Response(
            200,
            content={
                "unsupported": b"<html>not a document</html>",
                "oversized": TEXT_PDF,
                "scanned": EMPTY_PDF,
                "malformed": b"%PDF broken",
            }[document],
            headers={"content-type": "application/pdf"},
        )

    app = create_app(make_settings(**settings))
    app.state.scraper = FakeScraper(exc=RuntimeError("Page.goto: Download is starting"))
    app.state.http_client = mock_http_client(handler)
    response = TestClient(app).post(
        "/scrape", json={"url": "https://example.org/download"}, headers=auth_headers()
    )
    assert response.status_code == status
    assert error in str(response.json()["detail"])
    assert len(app.state.scraper.calls) == 1


def test_scrape_download_snapshot_is_not_misrepresented_as_an_archive(app):
    from tests.conftest import mock_http_client

    def unexpected(_request):
        raise AssertionError("snapshot rejection must not download or invoke OCR")

    app.state.scraper = FakeScraper(exc=RuntimeError("Page.goto: Download is starting"))
    app.state.http_client = mock_http_client(unexpected)
    response = TestClient(app).post(
        "/scrape",
        json={"url": "https://example.org/download", "snapshot": True},
        headers=auth_headers(),
    )
    assert response.status_code == 422


def test_download_http_client_blocks_rebinding_at_the_proxy(monkeypatch):
    from app import network_policy

    # Initial public-host checks pass, but the destination becomes private
    # when the actual connect is resolved. No connection to that IP may occur.
    def rebound_addresses(_host, port=None):
        return {"93.184.216.34"} if port is None else {"169.254.169.254"}

    monkeypatch.setattr(pdfparse, "resolve_addresses", rebound_addresses)
    monkeypatch.setattr(network_policy, "resolve_addresses", rebound_addresses)
    app = create_app(make_settings())
    app.state.scraper = FakeScraper(exc=RuntimeError("Page.goto: Download is starting"))
    with TestClient(app) as client:
        response = client.post(
            "/scrape", json={"url": "https://council.example/download"}, headers=auth_headers()
        )
        assert response.status_code == 422
        assert app.state.egress_stats.blocked == 1
        assert app.state.egress_stats.allowed == 0


def test_operation_counter_is_content_free(app, caplog):
    app.state.scraper = FakeScraper(result=crawl_result())
    secret_url = "https://example.org/private-user-path"
    headers = auth_headers() | {"X-Scoutpost-Workload-Class": "scout"}
    with caplog.at_level(logging.INFO, logger="uvicorn.error"):
        res = TestClient(app).post(
            "/scrape", json={"url": secret_url}, headers=headers
        )
    assert res.status_code == 200
    records = [json.loads(record.message) for record in caplog.records]
    assert records[-1].keys() == {"minute", "operation", "workload_class"}
    assert records[-1]["operation"] == "scrape"
    assert records[-1]["workload_class"] == "scout"
    assert secret_url not in caplog.text


@pytest.mark.asyncio
async def test_operation_counter_heartbeat_is_content_free(monkeypatch):
    records = []
    sleep_delays = []

    class NearBoundaryDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 8, 4, 8, 41, 59, 999_000, tzinfo=timezone.utc)

    async def stop_after_first(seconds):
        sleep_delays.append(seconds)
        raise asyncio.CancelledError

    monkeypatch.setattr(
        main, "record_operation", lambda *args: records.append(args)
    )
    monkeypatch.setattr(main, "datetime", NearBoundaryDatetime)
    monkeypatch.setattr(main.asyncio, "sleep", stop_after_first)
    with pytest.raises(asyncio.CancelledError):
        await main.emit_operation_heartbeats()
    assert records == [("heartbeat", "system")]
    assert sleep_delays == [pytest.approx(1.001)]


def test_scrape_custom_timeout_forwarded(app):
    fake = FakeScraper(result=crawl_result())
    app.state.scraper = fake
    res = TestClient(app).post(
        "/scrape",
        json={"url": "https://example.org", "timeout_ms": 12_000},
        headers=auth_headers(),
    )
    assert res.status_code == 200
    assert fake.calls == [("https://example.org", 12_000)]


def test_scrape_timeout_maps_to_504(app):
    # The fake raises TimeoutError from run(); the endpoint's wait_for except
    # clause catches it identically to a fuse expiry.
    import asyncio

    fake = FakeScraper(exc=asyncio.TimeoutError())
    app.state.scraper = fake
    res = TestClient(app).post(
        "/scrape", json={"url": "https://example.org"}, headers=auth_headers()
    )
    assert res.status_code == 504
    assert res.json()["detail"]["error"] == "navigation_timeout"


def test_scrape_library_error_maps_to_502(app):
    app.state.scraper = FakeScraper(exc=RuntimeError("browser crashed"))
    res = TestClient(app).post(
        "/scrape", json={"url": "https://example.org"}, headers=auth_headers()
    )
    assert res.status_code == 502
    assert "browser crashed" in res.json()["detail"]


def test_scrape_unsuccessful_result_maps_to_502(app):
    app.state.scraper = FakeScraper(
        result=crawl_result(success=False, status_code=403, error_message="bot wall")
    )
    res = TestClient(app).post(
        "/scrape", json={"url": "https://example.org"}, headers=auth_headers()
    )
    assert res.status_code == 502
    assert "status 403; bot wall" in res.json()["detail"]


def test_scrape_rejects_non_http_schemes(app):
    for url in ("file:///etc/passwd", "ftp://x", "chrome://settings", "not-a-url"):
        res = TestClient(app).post("/scrape", json={"url": url}, headers=auth_headers())
        assert res.status_code == 422, url


def test_scrape_blocks_private_addresses(app, monkeypatch):
    # SSRF parity with /parse: a host resolving to a private/loopback address is
    # rejected before the browser renders it (snapshot capture would otherwise
    # persist the internal response behind a signed URL).
    monkeypatch.setattr(
        pdfparse.socket,
        "getaddrinfo",
        lambda host, port: [(2, 1, 6, "", ("169.254.169.254", 0))],
    )
    app.state.scraper = FakeScraper(result=crawl_result())
    res = TestClient(app).post(
        "/scrape", json={"url": "https://metadata.internal/latest"}, headers=auth_headers()
    )
    assert res.status_code == 422
    assert res.json()["detail"]["error"] == "private_address"


def test_rejects_private_effective_url(app, monkeypatch):
    def resolve(host, port):
        address = "93.184.216.34" if host == "example.org" else "169.254.169.254"
        return [(2, 1, 6, "", (address, 0))]

    monkeypatch.setattr(pdfparse.socket, "getaddrinfo", resolve)
    app.state.scraper = FakeScraper(
        result=crawl_result(url="http://169.254.169.254/latest")
    )
    res = TestClient(app).post(
        "/scrape", json={"url": "https://example.org"}, headers=auth_headers()
    )
    assert res.status_code == 422
    assert res.json()["detail"]["error"] == "private_address"


def test_scrape_rejects_unresolvable_effective_url(app, monkeypatch):
    def resolve(host, port):
        if host == "example.org":
            return [(2, 1, 6, "", ("93.184.216.34", 0))]
        raise OSError("Name or service not known")

    monkeypatch.setattr(pdfparse.socket, "getaddrinfo", resolve)
    app.state.scraper = FakeScraper(
        result=crawl_result(url="https://redirect.invalid/final")
    )
    res = TestClient(app).post(
        "/scrape", json={"url": "https://example.org"}, headers=auth_headers()
    )
    assert res.status_code == 422
    assert "cannot resolve host" in res.json()["detail"]


def test_lifespan_pins_browser_egress_through_guarded_proxy(monkeypatch):
    @asynccontextmanager
    async def fake_guarded_egress():
        yield SimpleNamespace(
            proxy_url="http://127.0.0.1:43123",
            stats=SimpleNamespace(),
        )

    monkeypatch.setattr(main, "guarded_egress", fake_guarded_egress)
    app = create_app(make_settings())
    with TestClient(app):
        assert isinstance(app.state.scraper, Scraper)
        assert app.state.scraper._proxy_server.startswith("http://127.0.0.1:")


def test_lifespan_preserves_private_address_opt_out():
    app = create_app(make_settings(block_private_addresses=False))
    with TestClient(app):
        assert isinstance(app.state.scraper, Scraper)
        assert app.state.scraper._proxy_server is None


def test_scrape_rejects_unresolvable_host(app, monkeypatch):
    # A host that won't resolve makes assert_public_host raise PdfDownloadError;
    # /scrape maps it to a 422 rather than letting the browser attempt it.
    def boom(host, port):
        raise OSError("Name or service not known")

    monkeypatch.setattr(pdfparse.socket, "getaddrinfo", boom)
    app.state.scraper = FakeScraper(result=crawl_result())
    res = TestClient(app).post(
        "/scrape", json={"url": "https://nope.invalid/x"}, headers=auth_headers()
    )
    assert res.status_code == 422
    assert "cannot resolve host" in res.json()["detail"]


def test_scrape_allows_private_addresses_when_opted_out(monkeypatch):
    # Self-host escape hatch: SCRAPE_ALLOW_PRIVATE_ADDRESSES disables the guard.
    monkeypatch.setattr(
        pdfparse.socket,
        "getaddrinfo",
        lambda host, port: [(2, 1, 6, "", ("127.0.0.1", 0))],
    )
    app = create_app(make_settings(block_private_addresses=False))
    app.state.scraper = FakeScraper(result=crawl_result())
    res = TestClient(app).post(
        "/scrape", json={"url": "https://internal.example/dash"}, headers=auth_headers()
    )
    assert res.status_code == 200


def test_scrape_timeout_bounds_validated(app):
    res = TestClient(app).post(
        "/scrape",
        json={"url": "https://example.org", "timeout_ms": 500_000},
        headers=auth_headers(),
    )
    assert res.status_code == 422


def test_real_scraper_starts_cold():
    scraper = Scraper(pool_size=2)
    assert scraper.warm is False


def test_mapping_drift_maps_to_502(app):
    from types import SimpleNamespace

    app.state.scraper = FakeScraper(
        result=crawl_result(markdown=SimpleNamespace(other="drifted"))
    )
    res = TestClient(app).post(
        "/scrape", json={"url": "https://example.org"}, headers=auth_headers()
    )
    assert res.status_code == 502
    assert "mapping failed" in res.json()["detail"]


def test_docs_surfaces_disabled(app):
    client = TestClient(app)
    for path in ("/docs", "/redoc", "/openapi.json"):
        assert client.get(path).status_code == 404, path


class BlockingScraper(FakeScraper):
    def __init__(self) -> None:
        super().__init__(result=crawl_result())
        self.started = 0
        self.release_event = asyncio.Event()

    async def run(self, url: str, timeout_ms: int, snapshot: bool = False):
        self.calls.append((url, timeout_ms))
        self.snapshot_flags.append(snapshot)
        self.started += 1
        await self.release_event.wait()
        return self.result


async def wait_until_started(scraper: BlockingScraper, count: int) -> None:
    async def wait() -> None:
        while scraper.started < count:
            await asyncio.sleep(0)

    await asyncio.wait_for(wait(), timeout=0.5)


def scrape_request(
    client: httpx.AsyncClient,
    suffix: str,
    *,
    snapshot: bool = False,
):
    return client.post(
        "/scrape",
        json={
            "url": f"https://example.org/{suffix}",
            "snapshot": snapshot,
        },
        headers=auth_headers(),
    )


@pytest.mark.asyncio
async def test_scrape_sheds_excess_ordinary_work_and_keeps_health_responsive(app):
    """A Beat burst must not create an unbounded queue behind two browser slots."""
    blocker = BlockingScraper()
    app.state.scraper = blocker
    transport = httpx.ASGITransport(app=app)
    requests: list[asyncio.Task[httpx.Response]] = []
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://test",
    ) as client:
        try:
            for suffix in ("a", "b"):
                requests.append(
                    asyncio.create_task(scrape_request(client, suffix))
                )
            await wait_until_started(blocker, 2)

            health = await asyncio.wait_for(
                client.get("/health"), timeout=0.5
            )
            assert health.status_code == 200

            excess = await asyncio.wait_for(
                scrape_request(client, "excess"),
                timeout=0.5,
            )
            assert excess.status_code == 503
            assert excess.headers["retry-after"] == "1"
            assert blocker.started == 2
        finally:
            blocker.release_event.set()
            if requests:
                responses = await asyncio.gather(*requests)
                assert all(response.status_code == 200 for response in responses)


@pytest.mark.asyncio
async def test_scrape_sheds_parallel_snapshot_capture_without_blocking_ordinary_slot(app):
    """Archive batches degrade excess captures instead of monopolizing ingress."""
    blocker = BlockingScraper()
    app.state.scraper = blocker
    transport = httpx.ASGITransport(app=app)
    requests: list[asyncio.Task[httpx.Response]] = []
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://test",
    ) as client:
        try:
            requests.append(
                asyncio.create_task(
                    scrape_request(client, "archive-a", snapshot=True)
                )
            )
            await wait_until_started(blocker, 1)

            excess = await asyncio.wait_for(
                scrape_request(client, "archive-b", snapshot=True),
                timeout=0.5,
            )
            assert excess.status_code == 503

            ordinary = asyncio.create_task(
                scrape_request(client, "page")
            )
            requests.append(ordinary)
            await wait_until_started(blocker, 2)
            assert blocker.snapshot_flags == [True, False]
        finally:
            blocker.release_event.set()
            if requests:
                responses = await asyncio.gather(*requests)
                assert all(response.status_code == 200 for response in responses)


# --- PAGE-ARCHIVE-PRD U1: inline snapshot capture ---------------------------


def test_scrape_without_snapshot_flag_requests_no_capture(app):
    fake = FakeScraper(result=crawl_result())
    app.state.scraper = fake
    res = TestClient(app).post(
        "/scrape", json={"url": "https://example.org"}, headers=auth_headers()
    )
    assert res.status_code == 200
    assert fake.snapshot_flags == [False]
    body = res.json()
    assert "snapshot" not in body
    assert "snapshot_error" not in body
    # response_headers is mapped for every scrape (U1)
    assert body["response_headers"] == {"content-type": "text/html; charset=utf-8"}


def test_scrape_snapshot_happy_path_returns_inline_payload(app):
    import base64 as b64
    import hashlib

    png = b"\x89PNG\r\n\x1a\npixels"
    fake = FakeScraper(
        result=crawl_result(
            mhtml="MIME-Version: 1.0\n\nsnapshot body",
            screenshot=b64.b64encode(png).decode("ascii"),
        )
    )
    app.state.scraper = fake
    res = TestClient(app).post(
        "/scrape",
        json={"url": "https://example.org", "snapshot": True},
        headers=auth_headers(),
    )
    assert res.status_code == 200
    assert fake.snapshot_flags == [True]
    body = res.json()
    snapshot = body["snapshot"]
    assert snapshot["screenshot_sha256"] == hashlib.sha256(png).hexdigest()
    assert b64.b64decode(snapshot["mhtml_b64"]).decode() == "MIME-Version: 1.0\n\nsnapshot body"
    assert body["markdown"] == "# Heading\n\nBody text."  # scrape contract unchanged


def test_scrape_snapshot_capture_failure_degrades_not_fails(app):
    # crawl4ai produced no capture artifacts: the scrape must still succeed
    # with markdown, carrying a structured snapshot_error instead of a payload.
    fake = FakeScraper(result=crawl_result())  # no mhtml/screenshot attrs beyond defaults
    app.state.scraper = fake
    res = TestClient(app).post(
        "/scrape",
        json={"url": "https://example.org", "snapshot": True},
        headers=auth_headers(),
    )
    assert res.status_code == 200
    body = res.json()
    assert "snapshot" not in body
    assert body["snapshot_error"].startswith("capture_incomplete")
    assert body["markdown"] == "# Heading\n\nBody text."


def test_scrape_snapshot_rejects_error_card_screenshot(app):
    # The REAL crawl4ai failure shape (finding: screenshots never fail loudly
    # — a black JPEG error card comes back instead). Must degrade, not seal.
    import base64 as b64

    fake = FakeScraper(
        result=crawl_result(
            mhtml="MIME-Version: 1.0\n\nbody",
            screenshot=b64.b64encode(b"\xff\xd8\xff\xe0error-card").decode("ascii"),
        )
    )
    app.state.scraper = fake
    res = TestClient(app).post(
        "/scrape",
        json={"url": "https://example.org", "snapshot": True},
        headers=auth_headers(),
    )
    assert res.status_code == 200
    body = res.json()
    assert "snapshot" not in body
    assert body["snapshot_error"].startswith("screenshot_not_png:")
    assert body["markdown"] == "# Heading\n\nBody text."


def test_scrape_snapshot_assembly_exception_never_escapes(app):
    # An unexpected payload-assembly crash must degrade to snapshot_error,
    # never 500 the scrape away from its markdown.
    class Unencodable:
        def __bool__(self):
            return True

    fake = FakeScraper(
        result=crawl_result(mhtml=Unencodable(), screenshot="aGVsbG8=")
    )
    app.state.scraper = fake
    res = TestClient(app).post(
        "/scrape",
        json={"url": "https://example.org", "snapshot": True},
        headers=auth_headers(),
    )
    assert res.status_code == 200
    body = res.json()
    assert body["snapshot_error"].startswith("payload_assembly_failed:")
    assert body["markdown"] == "# Heading\n\nBody text."

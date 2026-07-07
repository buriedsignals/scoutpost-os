from fastapi.testclient import TestClient

from app.scraper import Scraper
from tests.conftest import FakeScraper, auth_headers, crawl_result


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
    assert "timed out" in res.json()["detail"]


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

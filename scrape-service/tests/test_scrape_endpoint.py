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

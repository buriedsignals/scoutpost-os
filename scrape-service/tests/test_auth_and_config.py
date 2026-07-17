import pytest
from fastapi.testclient import TestClient

from app.config import load_settings
from app.main import create_app
from tests.conftest import TEST_TOKEN, auth_headers, make_settings


def test_scrape_requires_token(app):
    client = TestClient(app)
    assert client.post("/scrape", json={"url": "https://example.org"}).status_code == 401


def test_parse_requires_token(app):
    client = TestClient(app)
    assert client.post("/parse", json={"url": "https://example.org/x.pdf"}).status_code == 401


def test_wrong_token_rejected(app):
    client = TestClient(app)
    res = client.post(
        "/scrape",
        json={"url": "https://example.org"},
        headers={"Authorization": "Bearer wrong"},
    )
    assert res.status_code == 401


def test_health_is_unauthenticated(app):
    res = TestClient(app).get("/health")
    assert res.status_code == 200
    assert res.json()["status"] == "ok"
    assert res.json()["browser"] in ("warm", "cold")


def test_anon_mode_allows_requests_when_opted_in():
    from tests.conftest import FakeScraper, crawl_result

    app = create_app(make_settings(token=None, allow_anon=True))
    app.state.scraper = FakeScraper(result=crawl_result())
    res = TestClient(app).post("/scrape", json={"url": "https://example.org"})
    assert res.status_code == 200


def test_load_settings_refuses_open_proxy():
    with pytest.raises(RuntimeError, match="open proxy"):
        load_settings(env={})


def test_load_settings_anon_optin():
    settings = load_settings(env={"SCRAPE_SERVICE_DEV_NO_AUTH": "1"})
    assert settings.token is None
    assert settings.allow_anon is True


def test_load_settings_reads_values():
    settings = load_settings(
        env={
            "SCRAPE_SERVICE_TOKEN": TEST_TOKEN,
            "SCRAPE_BROWSER_POOL_SIZE": "3",
            "SCRAPE_DEFAULT_TIMEOUT_MS": "10000",
            "PARSE_DOWNLOAD_TIMEOUT_S": "7.5",
            "PARSE_MAX_PDF_BYTES": "1024",
            "PARSE_MIN_CHARS_PER_PAGE": "42",
            "OPENROUTER_API_KEY": "or-key",
            "PARSE_OPENROUTER_MODEL": "google/gemini-2.5-pro",
            "PARSE_OPENROUTER_TIMEOUT_S": "45",
        }
    )
    assert settings.token == TEST_TOKEN
    assert settings.browser_pool_size == 3
    assert settings.default_scrape_timeout_ms == 10_000
    assert settings.parse_download_timeout_s == 7.5
    assert settings.parse_max_pdf_bytes == 1024
    assert settings.parse_min_chars_per_page == 42
    assert settings.openrouter_api_key == "or-key"
    assert settings.openrouter_model == "google/gemini-2.5-pro"
    assert settings.openrouter_timeout_s == 45.0


def test_load_settings_openrouter_defaults_off():
    settings = load_settings(env={"SCRAPE_SERVICE_TOKEN": TEST_TOKEN})
    assert settings.openrouter_api_key is None
    assert settings.openrouter_model == "google/gemini-2.5-flash-lite"
    assert settings.openrouter_timeout_s == 90.0


def test_create_app_loads_settings_from_env(monkeypatch):
    monkeypatch.setenv("SCRAPE_SERVICE_TOKEN", TEST_TOKEN)
    app = create_app()
    with TestClient(app):  # runs lifespan: startup + scraper.close() on exit
        pass
    assert app.state.settings.token == TEST_TOKEN


def test_auth_headers_helper_matches_token(app):
    # sanity: the helper used across tests actually authenticates
    from tests.conftest import FakeScraper, crawl_result

    app.state.scraper = FakeScraper(result=crawl_result())
    res = TestClient(app).post(
        "/scrape", json={"url": "https://example.org"}, headers=auth_headers()
    )
    assert res.status_code == 200

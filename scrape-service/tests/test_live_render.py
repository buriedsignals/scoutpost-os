"""Live browser tests — the only tier that exercises the real Crawl4AI path.

Run locally (requires `pip install -r requirements.txt` + `crawl4ai-setup`):
    pytest -m live --no-cov

Excluded from the CI unit tier (pytest.ini deselects `live`); the container
healthcheck plus scripts/dev/scrape-stack.sh cover this path in Docker.
"""

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from tests.conftest import auth_headers, make_settings

pytestmark = pytest.mark.live


def test_scrape_renders_a_real_page():
    app = create_app(make_settings())
    with TestClient(app) as client:
        res = client.post(
            "/scrape",
            json={"url": "https://example.com", "timeout_ms": 30_000},
            headers=auth_headers(),
        )
        assert res.status_code == 200
        body = res.json()
        assert "Example Domain" in body["markdown"]
        assert body["status_code"] == 200
        assert client.get("/health").json()["browser"] == "warm"

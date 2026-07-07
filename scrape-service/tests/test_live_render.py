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


def test_snapshot_captures_under_production_browser_config():
    """PAGE-ARCHIVE-PRD U1: capture_mhtml + screenshot must be proven under
    the UndetectedAdapter + stealth (+ headed/xvfb in the container) config —
    not vanilla Playwright. Verifies same-render MHTML with inlined
    subresources and a full-page PNG whose hash matches the shipped bytes."""
    import base64
    import hashlib

    app = create_app(make_settings())
    with TestClient(app) as client:
        res = client.post(
            "/scrape",
            json={
                "url": "https://en.wikipedia.org/wiki/Web_archiving",
                "timeout_ms": 60_000,
                "snapshot": True,
            },
            headers=auth_headers(),
        )
        assert res.status_code == 200
        body = res.json()
        snapshot = body.get("snapshot")
        assert snapshot, f"snapshot missing: {body.get('snapshot_error')}"
        mhtml = base64.b64decode(snapshot["mhtml_b64"])
        assert hashlib.sha256(mhtml).hexdigest() == snapshot["mhtml_sha256"]
        # A real MHTML document: multipart/related with MIME boundaries and
        # inlined subresources.
        head = mhtml[:2048].decode("utf-8", errors="replace")
        assert "multipart/related" in head
        assert mhtml.count(b"Content-Type:") > 3  # subresources inlined
        png = base64.b64decode(snapshot["screenshot_b64"])
        assert png[:8] == b"\x89PNG\r\n\x1a\n"  # verbatim PNG, no transcode
        assert hashlib.sha256(png).hexdigest() == snapshot["screenshot_sha256"]
        assert body["response_headers"], "headers must map on snapshot fetches"

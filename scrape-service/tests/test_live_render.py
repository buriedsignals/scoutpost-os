"""Live browser tests — the only tier that exercises the real Crawl4AI path.

Run locally (requires `pip install -r requirements.txt` + `crawl4ai-setup`):
    pytest -m live --no-cov

Excluded from the CI unit tier (pytest.ini deselects `live`); the container
healthcheck plus scripts/dev/scrape-stack.sh cover this path in Docker.
"""

from email import policy
from email.parser import Parser
import re

import pytest
from fastapi.testclient import TestClient

import app.scraper as scraper_module
from app.main import create_app
from app.scraper import Scraper
from tests.conftest import auth_headers, make_settings

pytestmark = pytest.mark.live

DISCLOSURE_SENTINEL = "CLICK_MOUNTED_DISCLOSURE_SENTINEL"
SECOND_DISCLOSURE_SENTINEL = "SECOND_CLICK_MOUNTED_DISCLOSURE_SENTINEL"
NATIVE_DETAILS_SENTINEL = "NATIVE_DETAILS_SENTINEL"
FORM_BUTTON_SENTINEL = "FORM_BUTTON_SENTINEL"
FINAL_HOST_SENTINEL = "FINAL_HOST_SENTINEL"
MIXED_FIRST_SENTINEL = "MIXED_FIRST_SENTINEL"
MIXED_SECOND_SENTINEL = "MIXED_SECOND_SENTINEL"
UNRELATED_BUTTON_SENTINEL = "UNRELATED_BUTTON_SENTINEL"


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


async def test_disclosure_content_is_mounted_before_same_render_capture(
    monkeypatch,
):
    fixture = f"""
        <main>
          <details>
            <summary>Native disclosure</summary>
            <p>{NATIVE_DETAILS_SENTINEL}</p>
          </details>
          <section id="tiktok-panels">
            <div data-testid="marcom-web-collapse-panel">
              <button id="first-panel" type="button">More information</button>
            </div>
            <div data-testid="marcom-web-collapse-panel">
              <button type="button">More information</button>
            </div>
          </section>
          <form id="unsafe-form">
            <div data-testid="marcom-web-collapse-panel">
              <button id="form-button" type="button">Do not click</button>
            </div>
          </form>
        </main>
        <nav>
          <button
            id="unrelated"
            type="button"
            aria-expanded="false"
            aria-controls="unrelated-target"
          >Navigation control</button>
        </nav>
        <script>
          const panels = document.querySelector("#tiktok-panels");
          document.querySelector("#first-panel").addEventListener(
            "click",
            () => {{
              panels.innerHTML = `
                <div data-testid="marcom-web-collapse-panel">
                  <button type="button">Already opened</button>
                  <p>{DISCLOSURE_SENTINEL}</p>
                </div>
                <div data-testid="marcom-web-collapse-panel">
                  <button id="replacement-panel" type="button">
                    More information
                  </button>
                </div>
              `;
              document.querySelector("#replacement-panel").addEventListener(
                "click",
                (event) => {{
                  event.currentTarget.insertAdjacentHTML(
                    "afterend",
                    "<p>{SECOND_DISCLOSURE_SENTINEL}</p>"
                  );
                }}
              );
            }}
          );
          document.querySelector("#form-button").addEventListener(
            "click",
            () => {{
              document.body.insertAdjacentHTML(
                "beforeend",
                "<p>{FORM_BUTTON_SENTINEL}</p>"
              );
            }}
          );
          document.querySelector("#unrelated").addEventListener("click", () => {{
            document.body.insertAdjacentHTML(
              "beforeend",
              "<p>{UNRELATED_BUTTON_SENTINEL}</p>"
            );
          }});
        </script>
    """
    # A raw: fixture has no hostname. Substitute the production script selected
    # for TikTok while retaining Scraper.run's exact capture configuration.
    tiktok_script = scraper_module._disclosure_js_for_url(
        "https://www.tiktok.com/safety/en/policies-and-engagement/"
    ).replace('window.location.hostname', '"www.tiktok.com"', 1)
    monkeypatch.setattr(
        scraper_module,
        "_disclosure_js_for_url",
        lambda _url: tiktok_script,
    )
    scraper = Scraper(pool_size=1)
    try:
        result = await scraper.run(
            f"raw:{fixture}",
            timeout_ms=30_000,
            snapshot=True,
        )
    finally:
        await scraper.close()

    assert result.success, result.error_message
    assert DISCLOSURE_SENTINEL in result.markdown.raw_markdown
    assert SECOND_DISCLOSURE_SENTINEL in result.markdown.raw_markdown
    assert NATIVE_DETAILS_SENTINEL in result.markdown.raw_markdown
    assert FORM_BUTTON_SENTINEL not in result.markdown.raw_markdown
    assert UNRELATED_BUTTON_SENTINEL not in result.markdown.raw_markdown
    assert "<details open" in result.html
    archive = Parser(policy=policy.default).parsestr(result.mhtml)
    archived_html = "\n".join(
        part.get_content()
        for part in archive.walk()
        if part.get_content_type() == "text/html"
    )
    assert DISCLOSURE_SENTINEL in archived_html
    assert SECOND_DISCLOSURE_SENTINEL in archived_html
    assert FORM_BUTTON_SENTINEL not in archived_html
    assert UNRELATED_BUTTON_SENTINEL not in archived_html


async def test_custom_disclosures_require_tiktok_final_origin(monkeypatch):
    fixture = f"""
        <main>
          <details>
            <summary>Native disclosure</summary>
            <p>{NATIVE_DETAILS_SENTINEL}</p>
          </details>
          <div data-testid="marcom-web-collapse-panel">
            <button id="custom-panel" type="button">More information</button>
          </div>
        </main>
        <script>
          document.querySelector("#custom-panel").addEventListener(
            "click",
            (event) => {{
              event.currentTarget.insertAdjacentHTML(
                "afterend",
                "<p>{FINAL_HOST_SENTINEL}</p>"
              );
            }}
          );
        </script>
    """
    # Force the requested-host-selected script onto raw:'s blank final origin.
    # The in-browser hostname gate must suppress only the custom click pass.
    production_script = scraper_module._disclosure_js_for_url(
        "https://www.tiktok.com/safety/"
    )
    poison_string_methods = """
const originalToLowerCase = String.prototype.toLowerCase;
const originalEndsWith = String.prototype.endsWith;
const originalSlice = String.prototype.slice;
try {
    String.prototype.toLowerCase = () => "tiktok.com";
    String.prototype.endsWith = () => true;
    String.prototype.slice = () => "tiktok.com";
"""
    restore_string_methods = """
} finally {
    String.prototype.toLowerCase = originalToLowerCase;
    String.prototype.endsWith = originalEndsWith;
    String.prototype.slice = originalSlice;
}
"""
    tiktok_script = (
        poison_string_methods + production_script + restore_string_methods
    )
    monkeypatch.setattr(
        scraper_module,
        "_disclosure_js_for_url",
        lambda _url: tiktok_script,
    )
    scraper = Scraper(pool_size=1)
    try:
        result = await scraper.run(
            f"raw:{fixture}",
            timeout_ms=30_000,
        )
    finally:
        await scraper.close()

    assert result.success, result.error_message
    assert NATIVE_DETAILS_SENTINEL in result.markdown.raw_markdown
    assert FINAL_HOST_SENTINEL not in result.markdown.raw_markdown
    assert "<details open" in result.html


async def test_native_and_custom_disclosures_share_interaction_cap(monkeypatch):
    details = "".join(
        f"""
          <details id="mixed-details-{index}">
            <summary>Disclosure {index}</summary>
            <p>Disclosure body {index}</p>
          </details>
        """
        for index in range(31)
    )
    fixture = f"""
        <main>
          {details}
          <div data-testid="marcom-web-collapse-panel">
            <button id="mixed-first" type="button">More information</button>
          </div>
          <div data-testid="marcom-web-collapse-panel">
            <button id="mixed-second" type="button">More information</button>
          </div>
        </main>
        <script>
          document.querySelector("#mixed-first").addEventListener(
            "click",
            (event) => {{
              event.currentTarget.insertAdjacentHTML(
                "afterend",
                "<p>{MIXED_FIRST_SENTINEL}</p>"
              );
            }}
          );
          document.querySelector("#mixed-second").addEventListener(
            "click",
            (event) => {{
              event.currentTarget.insertAdjacentHTML(
                "afterend",
                "<p>{MIXED_SECOND_SENTINEL}</p>"
              );
            }}
          );
        </script>
    """
    tiktok_script = scraper_module._disclosure_js_for_url(
        "https://www.tiktok.com/safety/"
    ).replace('window.location.hostname', '"www.tiktok.com"', 1)
    monkeypatch.setattr(
        scraper_module,
        "_disclosure_js_for_url",
        lambda _url: tiktok_script,
    )
    scraper = Scraper(pool_size=1)
    try:
        result = await scraper.run(
            f"raw:{fixture}",
            timeout_ms=30_000,
        )
    finally:
        await scraper.close()

    assert result.success, result.error_message
    opened_tag = re.search(
        r'<details[^>]*id="mixed-details-30"[^>]*>',
        result.html,
    )
    assert opened_tag and " open" in opened_tag.group(0)
    assert MIXED_FIRST_SENTINEL in result.markdown.raw_markdown
    assert MIXED_SECOND_SENTINEL not in result.markdown.raw_markdown


async def test_native_disclosure_expansion_respects_shared_cap():
    details = "".join(
        f"""
          <details id="details-{index}">
            <summary>Disclosure {index}</summary>
            <p>Disclosure body {index}</p>
          </details>
        """
        for index in range(33)
    )
    scraper = Scraper(pool_size=1)
    try:
        result = await scraper.run(
            f"raw:<main>{details}</main>",
            timeout_ms=30_000,
        )
    finally:
        await scraper.close()

    assert result.success, result.error_message
    opened_tag = re.search(
        r'<details[^>]*id="details-31"[^>]*>',
        result.html,
    )
    capped_tag = re.search(
        r'<details[^>]*id="details-32"[^>]*>',
        result.html,
    )
    assert opened_tag and " open" in opened_tag.group(0)
    assert capped_tag and " open" not in capped_tag.group(0)

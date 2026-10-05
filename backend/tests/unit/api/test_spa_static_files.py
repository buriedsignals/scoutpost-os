"""Tests for SPAStaticFiles — the mount that serves the SvelteKit build.

Regression guard for the 2026-04-24 production blank-page incident where the
custom SPA fallback returned `index.html` (text/html, 200) for every missing
file including hashed JS bundles under `/_app/immutable/*`. The browser's
module MIME guard rejected the response, leaving users on a blank page for
hours because Cloudflare's default 4h browser TTL then cached the bad response.

The mount is normally wired up at app-construction time against the real
frontend build directory (populated by the Dockerfile). It's skipped in local
CI since there is no `backend/app/frontend_client/`. These tests therefore
instantiate SPAStaticFiles directly against a tmp directory so the behavior is
deterministic regardless of whether the real build is present.
"""
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.main import SPAStaticFiles


def _build_frontend(root: Path) -> None:
    """Write a minimal SvelteKit-like build tree into `root`."""
    asset_dir = root / "_app" / "immutable" / "entry"
    asset_dir.mkdir(parents=True, exist_ok=True)
    (asset_dir / "start.REALHASH.js").write_text("export const hi = 1;\n")
    (root / "index.html").write_text("<html>app shell</html>")


def _client(tmp_path: Path) -> TestClient:
    _build_frontend(tmp_path)
    app = FastAPI()
    app.mount("/", SPAStaticFiles(directory=str(tmp_path), html=True), name="frontend")
    return TestClient(app)


def test_existing_hashed_js_serves_with_javascript_mime(tmp_path):
    res = _client(tmp_path).get("/_app/immutable/entry/start.REALHASH.js")
    assert res.status_code == 200
    ctype = res.headers["content-type"]
    assert ctype.startswith("text/javascript") or ctype.startswith(
        "application/javascript"
    ), f"expected JS mime, got {ctype!r}"
    assert "export const hi" in res.text


def test_missing_hashed_js_returns_404_not_html(tmp_path):
    """Missing /_app/immutable/*.js MUST be 404, never index.html.

    Returning index.html causes the browser's module MIME guard to fail and
    the response itself becomes poisoned cache that survives for hours.
    """
    res = _client(tmp_path).get("/_app/immutable/entry/start.ZZZZZZZZ.js")
    assert res.status_code == 404
    assert "app shell" not in res.text


def test_missing_non_html_asset_paths_all_404(tmp_path):
    client = _client(tmp_path)
    for path in [
        "/_app/immutable/chunks/nope.js",
        "/favicon-nope.ico",
        "/fonts/missing.woff2",
        "/img/missing.png",
        "/styles/missing.css",
        "/something.map",
    ]:
        res = client.get(path)
        assert res.status_code == 404, (
            f"{path!r} returned {res.status_code}, body={res.text!r}"
        )


def test_unmatched_api_path_is_404_json(tmp_path):
    """Production 2026-10-05: unmatched /api/* reached the SPA mount and 500ed."""
    client = TestClient(_client(tmp_path).app, raise_server_exceptions=False)
    res = client.get("/api/v1/scouts")
    assert res.status_code == 404
    assert res.json() == {"detail": "Not Found"}
    assert res.headers["cache-control"] == "no-store"


def test_missing_spa_route_serves_index_html_with_no_cache(tmp_path):
    res = _client(tmp_path).get("/some/deep/spa/route")
    assert res.status_code == 200
    assert "text/html" in res.headers["content-type"]
    assert "app shell" in res.text
    cache_control = res.headers.get("cache-control", "").lower()
    assert "no-cache" in cache_control, (
        f"index.html SPA fallback must carry no-cache to avoid stale-HTML "
        f"pinning after deploys, got cache-control={cache_control!r}"
    )


def test_index_html_direct_serves_no_cache(tmp_path):
    res = _client(tmp_path).get("/")
    assert res.status_code == 200
    assert "app shell" in res.text
    cache_control = res.headers.get("cache-control", "").lower()
    assert "no-cache" in cache_control, (
        f"index.html at / must carry no-cache, got cache-control={cache_control!r}"
    )


def test_existing_immutable_asset_gets_long_immutable_cache(tmp_path):
    """Content-hashed /_app/immutable/* files must carry a long immutable
    cache-control header so CF's default 4h browser TTL is defeated and
    browsers can hold them forever without revalidation.
    """
    res = _client(tmp_path).get("/_app/immutable/entry/start.REALHASH.js")
    assert res.status_code == 200
    cache_control = res.headers.get("cache-control", "").lower()
    assert "immutable" in cache_control, (
        f"expected 'immutable' in cache-control, got {cache_control!r}"
    )
    assert "max-age=31536000" in cache_control, (
        f"expected 1-year max-age, got {cache_control!r}"
    )
    assert "public" in cache_control, (
        f"expected public (CF edge should be allowed to cache), got {cache_control!r}"
    )


def test_missing_immutable_asset_404_has_no_store(tmp_path):
    """Missing hashed asset 404s MUST carry no-store so CF's default 4h
    browser TTL cannot pin the 404 response at edge — a future rebuild
    could cause the same hash to exist again, and a CF-cached 404 would
    pin users to a broken state.
    """
    res = _client(tmp_path).get("/_app/immutable/entry/start.NOPE.js")
    assert res.status_code == 404
    cache_control = res.headers.get("cache-control", "").lower()
    assert "no-store" in cache_control, (
        f"expected no-store on asset 404, got {cache_control!r}"
    )


def test_non_404_http_exception_propagates(tmp_path, monkeypatch):
    """Non-404 HTTPExceptions from StaticFiles (e.g. 401 for permission
    errors, 405 for non-GET) must propagate — never get silently swallowed
    as a SPA fallback. Guards against regressions where a bug in the
    underlying Starlette code would be masked by our fallback logic.
    """
    import asyncio

    import pytest
    from starlette.exceptions import HTTPException

    _build_frontend(tmp_path)
    spa = SPAStaticFiles(directory=str(tmp_path), html=True)

    async def _raise_401(self, path, scope):  # noqa: ARG001
        raise HTTPException(status_code=401)

    monkeypatch.setattr(
        SPAStaticFiles.__mro__[1], "get_response", _raise_401
    )
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/anything.js",
        "headers": [],
    }
    with pytest.raises(HTTPException) as exc_info:
        asyncio.new_event_loop().run_until_complete(
            spa.get_response("anything.js", scope)
        )
    assert exc_info.value.status_code == 401


def test_api_prefix_bubbles_up_as_not_a_static_file(tmp_path):
    """/api/* paths must raise RuntimeError so FastAPI routers can handle them.

    Note: in the real app the mount is at / and /api/* routes are registered
    before it, so in practice this branch is only hit if a route is missing.
    """
    import pytest

    spa = SPAStaticFiles(directory=str(tmp_path), html=True)
    _build_frontend(tmp_path)
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/api/nonexistent",
        "headers": [],
    }
    with pytest.raises(RuntimeError):
        import asyncio

        asyncio.get_event_loop().run_until_complete(
            spa.get_response("api/nonexistent", scope)
        )


def test_prerendered_route_serves_its_html_not_the_shell(tmp_path):
    """Crawlers (e.g. OpenAI's privacy-policy check) don't run JS, so a
    prerendered route like /terms must return terms.html itself."""
    (tmp_path / "terms.html").write_text("<html>privacy policy text</html>")
    client = _client(tmp_path)
    res = client.get("/terms")
    assert res.status_code == 200
    assert "privacy policy text" in res.text
    assert res.headers["cache-control"] == "no-cache, must-revalidate"
    assert "app shell" in client.get("/not-prerendered").text

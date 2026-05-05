"""
Tests for the MuckRock compatibility proxy.

Covers the contract with MuckRock: they keep their pre-cutover URLs
(webhook POST + OAuth callback GET) and we quietly forward to Supabase
Edge Functions without breaking signatures or dropping query params.

Invariants pinned here:

  Webhook POST /api/auth/webhook →
    1. Forwards to the configured SUPABASE_BILLING_WEBHOOK_URL
    2. Forwards the raw request body byte-for-byte (HMAC depends on this)
    3. Strips hop-by-hop headers (host/content-length/transfer-encoding …)
       AND Authorization (we never want to relay bearers to Kong)
    4. Forwards custom headers (x-muckrock-signature etc. — future-proofs)
    5. Mirrors the upstream status code + body + content-type
    6. Returns sterile "Upstream unavailable" on connect failure (no
       DNS/cert detail leaked)
    7. Default upstream URL is pinned to supabase.co (config canary)

  OAuth callback GET /api/auth/callback →
    8. 302s to SUPABASE_AUTH_CALLBACK_URL with query params preserved
    9. Preserves signed `state` and `code` param byte-for-byte
   10. Error path (MuckRock returns ?error=access_denied) also forwards
   11. Sets Cache-Control: no-store so browsers don't cache the redirect

  Startup guard →
   12. Rejects non-supabase hosts (SSRF defense-in-depth)
   13. Rejects http:// scheme
   14. Accepts subdomains of supabase.co / supabase.in
"""
from unittest.mock import patch

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import muckrock_proxy


def _mount() -> TestClient:
    app = FastAPI()
    app.include_router(muckrock_proxy.router, prefix="/api/auth")
    return TestClient(app, follow_redirects=False)


class _FakeResp:
    def __init__(self, status_code: int, body: bytes, content_type: str = "application/json"):
        self.status_code = status_code
        self.content = body
        self.headers = {"content-type": content_type}


class _FakeClient:
    def __init__(self, response: _FakeResp):
        self._response = response
        self.calls: list[dict] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return None

    async def post(self, url: str, content: bytes, headers: dict) -> _FakeResp:
        self.calls.append({"url": url, "content": content, "headers": headers})
        return self._response


def _patch_client(response: _FakeResp) -> _FakeClient:
    return _FakeClient(response)


# ---------------------------------------------------------------------------
# Webhook path
# ---------------------------------------------------------------------------


def test_webhook_forwards_verbatim_body_and_url():
    fake = _patch_client(_FakeResp(200, b'{"status":"ok","processed":1}'))
    with patch("app.routers.muckrock_proxy.httpx.AsyncClient", return_value=fake):
        client = _mount()
        payload = b'{"timestamp":"1712345678","type":"user","uuids":["u1"],"signature":"abc"}'
        res = client.post(
            "/api/auth/webhook",
            content=payload,
            headers={"content-type": "application/json", "x-custom": "keep-me"},
        )

    assert res.status_code == 200
    assert res.json() == {"status": "ok", "processed": 1}
    assert len(fake.calls) == 1
    call = fake.calls[0]
    assert call["url"] == muckrock_proxy.SUPABASE_BILLING_WEBHOOK_URL
    assert call["content"] == payload


def test_webhook_strips_hop_by_hop_and_authorization_but_keeps_custom():
    fake = _patch_client(_FakeResp(200, b'{"ok":true}'))
    with patch("app.routers.muckrock_proxy.httpx.AsyncClient", return_value=fake):
        client = _mount()
        client.post(
            "/api/auth/webhook",
            content=b"{}",
            headers={
                "content-type": "application/json",
                "host": "www.cojournalist.ai",
                "authorization": "Bearer SHOULD-NOT-FORWARD",
                "x-muckrock-signature": "keep-me",
                "transfer-encoding": "chunked",
            },
        )

    fwd = {k.lower(): v for k, v in fake.calls[0]["headers"].items()}
    assert "host" not in fwd
    assert "content-length" not in fwd
    assert "transfer-encoding" not in fwd
    assert "authorization" not in fwd
    assert fwd.get("x-muckrock-signature") == "keep-me"


def test_webhook_mirrors_401_for_bad_signature():
    fake = _patch_client(_FakeResp(401, b'{"error":"invalid webhook signature"}'))
    with patch("app.routers.muckrock_proxy.httpx.AsyncClient", return_value=fake):
        client = _mount()
        res = client.post("/api/auth/webhook", content=b"{}")

    assert res.status_code == 401
    assert res.json() == {"error": "invalid webhook signature"}


def test_webhook_mirrors_upstream_5xx_body_and_status():
    fake = _patch_client(_FakeResp(500, b'{"error":"boom"}'))
    with patch("app.routers.muckrock_proxy.httpx.AsyncClient", return_value=fake):
        client = _mount()
        res = client.post("/api/auth/webhook", content=b"{}")

    assert res.status_code == 500
    assert res.json() == {"error": "boom"}


def test_webhook_upstream_connection_failure_returns_sterile_502():
    class _BrokenClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

        async def post(self, *a, **kw):
            raise httpx.ConnectError(
                "secret-infra-detail.supabase.co resolution failed: 10.0.0.1",
            )

    with patch("app.routers.muckrock_proxy.httpx.AsyncClient", return_value=_BrokenClient()):
        client = _mount()
        res = client.post("/api/auth/webhook", content=b"{}")

    assert res.status_code == 502
    body = res.json()
    # Body must NOT leak the underlying exception text (DNS resolver / IPs etc).
    assert body == {"detail": "Upstream unavailable"}
    assert "secret-infra-detail" not in str(body)
    assert "10.0.0.1" not in str(body)


def test_webhook_default_upstream_pinned_to_supabase():
    assert muckrock_proxy.SUPABASE_BILLING_WEBHOOK_URL.startswith("https://")
    assert muckrock_proxy.SUPABASE_BILLING_WEBHOOK_URL.endswith(
        "/functions/v1/billing-webhook",
    )
    assert ".supabase.co" in muckrock_proxy.SUPABASE_BILLING_WEBHOOK_URL


# ---------------------------------------------------------------------------
# Callback path
# ---------------------------------------------------------------------------


def test_callback_302s_with_query_params_preserved():
    client = _mount()
    state = "ZXlKdWIyNWpaU0k2SW5oNGVDSXNJblJ6SWpvME16UXlmUT09.deadbeef"
    res = client.get(
        f"/api/auth/callback?code=mr-auth-code-123&state={state}",
    )

    assert res.status_code == 302
    loc = res.headers["location"]
    assert loc.startswith(muckrock_proxy.SUPABASE_AUTH_CALLBACK_URL)
    assert "code=mr-auth-code-123" in loc
    assert f"state={state}" in loc
    assert res.headers["cache-control"] == "no-store"


def test_callback_preserves_error_query_from_muckrock():
    client = _mount()
    res = client.get(
        "/api/auth/callback?error=access_denied&error_description=user+cancelled",
    )
    assert res.status_code == 302
    loc = res.headers["location"]
    assert "error=access_denied" in loc
    assert "error_description=user+cancelled" in loc


def test_callback_no_query_still_redirects_cleanly():
    client = _mount()
    res = client.get("/api/auth/callback")
    assert res.status_code == 302
    assert res.headers["location"] == muckrock_proxy.SUPABASE_AUTH_CALLBACK_URL


def test_callback_default_upstream_pinned_to_supabase():
    assert muckrock_proxy.SUPABASE_AUTH_CALLBACK_URL.startswith("https://")
    assert muckrock_proxy.SUPABASE_AUTH_CALLBACK_URL.endswith(
        "/functions/v1/auth-muckrock/callback",
    )
    assert ".supabase.co" in muckrock_proxy.SUPABASE_AUTH_CALLBACK_URL


def test_mcp_callback_default_upstream_pinned_to_mcp_auth_function():
    assert muckrock_proxy.SUPABASE_MCP_AUTH_CALLBACK_URL.startswith("https://")
    assert muckrock_proxy.SUPABASE_MCP_AUTH_CALLBACK_URL.endswith(
        "/functions/v1/mcp-auth/callback",
    )
    assert ".supabase.co" in muckrock_proxy.SUPABASE_MCP_AUTH_CALLBACK_URL


def test_callback_routes_mcp_prefixed_state_to_mcp_auth_function():
    """The whole point of the split: an `mcp.`-prefixed state must land on
    the MCP-only EF, not the web broker. Regression here means MCP changes
    can't observe the right secrets/logs and web sign-in can't change
    behaviour without affecting MCP."""
    client = _mount()
    state = "mcp.ZXlKdWIyNWpaU0k2SW5oNGVDSXNJblJ6SWpvME16UXlmUT09.deadbeefcafef00d"
    res = client.get(f"/api/auth/callback?code=mr-auth-code-123&state={state}")

    assert res.status_code == 302
    loc = res.headers["location"]
    assert loc.startswith(muckrock_proxy.SUPABASE_MCP_AUTH_CALLBACK_URL)
    assert f"state={state}" in loc
    assert "code=mr-auth-code-123" in loc
    assert res.headers["cache-control"] == "no-store"


def test_callback_routes_unprefixed_state_to_web_broker():
    """The web sign-in flow must remain unaffected by the routing change."""
    client = _mount()
    state = "ZXlKdWIyNWpaU0k2SW5oNGVDSXNJblJ6SWpvME16UXlmUT09.deadbeef"
    res = client.get(f"/api/auth/callback?code=abc&state={state}")

    assert res.status_code == 302
    loc = res.headers["location"]
    assert loc.startswith(muckrock_proxy.SUPABASE_AUTH_CALLBACK_URL)
    assert not loc.startswith(muckrock_proxy.SUPABASE_MCP_AUTH_CALLBACK_URL)


def test_callback_routes_no_state_to_web_broker():
    """When MuckRock returns an error path with no state we still default
    to the web broker — only an explicit `mcp.` opt-in routes to MCP."""
    client = _mount()
    res = client.get("/api/auth/callback?error=access_denied")

    assert res.status_code == 302
    loc = res.headers["location"]
    assert loc.startswith(muckrock_proxy.SUPABASE_AUTH_CALLBACK_URL)
    assert not loc.startswith(muckrock_proxy.SUPABASE_MCP_AUTH_CALLBACK_URL)


# ---------------------------------------------------------------------------
# Startup guard — SSRF defense-in-depth
# ---------------------------------------------------------------------------


def test_validate_upstream_rejects_non_supabase_host():
    with pytest.raises(RuntimeError, match="supabase"):
        muckrock_proxy._validate_upstream("https://evil.com/x", "TEST")


def test_validate_upstream_rejects_http_scheme():
    with pytest.raises(RuntimeError, match="https"):
        muckrock_proxy._validate_upstream("http://x.supabase.co/x", "TEST")


def test_validate_upstream_accepts_subdomain():
    muckrock_proxy._validate_upstream(
        "https://foo.supabase.co/functions/v1/billing-webhook",
        "TEST",
    )


def test_validate_upstream_accepts_self_hosted_supabase_in():
    muckrock_proxy._validate_upstream(
        "https://x.supabase.in/functions/v1/billing-webhook",
        "TEST",
    )


def test_validate_upstream_accepts_localhost_http_for_dev_callback_proxy():
    muckrock_proxy._validate_upstream(
        "http://127.0.0.1:54321/functions/v1/auth-muckrock/callback",
        "TEST",
    )

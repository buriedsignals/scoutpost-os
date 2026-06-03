"""
Tests for the public same-origin broker to Supabase Edge Functions / MCP.

This covers the public contract advertised on scoutpost.ai:

  - /functions/v1/* forwards to the Supabase Edge Function gateway
  - /mcp* forwards to the mcp-server Edge Function
  - JWT Authorization is preserved
  - cj_ API keys are forwarded through X-Cojo-Api-Key with anon JWT auth
  - apikey is injected from config when the caller does not send one
  - hop-by-hop headers are stripped
"""

from __future__ import annotations

from unittest.mock import patch

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import public_edge_proxy


def _mount() -> TestClient:
    app = FastAPI()
    app.include_router(public_edge_proxy.router)
    return TestClient(app)


class _FakeResp:
    def __init__(self, status_code: int, body: bytes, headers: dict[str, str] | None = None):
        self.status_code = status_code
        self.content = body
        self.headers = headers or {"content-type": "application/json"}


class _FakeClient:
    def __init__(self, response: _FakeResp):
        self._response = response
        self.calls: list[dict] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return None

    async def request(self, method: str, url: str, content: bytes | None, headers: dict):
        self.calls.append(
            {
                "method": method,
                "url": url,
                "content": content,
                "headers": headers,
            },
        )
        return self._response


def test_functions_proxy_forwards_path_query_and_jwt_auth(monkeypatch):
    monkeypatch.setattr(public_edge_proxy.settings, "supabase_url", "https://proj.supabase.co")
    monkeypatch.setattr(public_edge_proxy.settings, "supabase_anon_key", "anon-from-settings")
    fake = _FakeClient(_FakeResp(200, b'{"ok":true}'))

    with patch("app.routers.public_edge_proxy.httpx.AsyncClient", return_value=fake):
        client = _mount()
        res = client.get(
            "/functions/v1/openapi-spec?format=json",
            headers={
                "authorization": "Bearer jwt.demo.token",
                "host": "scoutpost.ai",
            },
        )

    assert res.status_code == 200
    assert res.json() == {"ok": True}
    assert len(fake.calls) == 1
    call = fake.calls[0]
    assert call["method"] == "GET"
    assert call["url"] == "https://proj.supabase.co/functions/v1/openapi-spec?format=json"
    assert call["headers"]["authorization"] == "Bearer jwt.demo.token"
    assert call["headers"]["apikey"] == "anon-from-settings"
    forwarded = {k.lower(): v for k, v in call["headers"].items()}
    assert "host" not in forwarded
    assert "content-length" not in forwarded


def test_functions_proxy_moves_cj_key_out_of_authorization(monkeypatch):
    monkeypatch.setattr(public_edge_proxy.settings, "supabase_url", "https://proj.supabase.co")
    monkeypatch.setattr(public_edge_proxy.settings, "supabase_anon_key", "anon-from-settings")
    fake = _FakeClient(_FakeResp(200, b'{"ok":true}'))

    with patch("app.routers.public_edge_proxy.httpx.AsyncClient", return_value=fake):
        client = _mount()
        res = client.get(
            "/functions/v1/scouts",
            headers={"authorization": "Bearer cj_demo"},
        )

    assert res.status_code == 200
    headers = {k.lower(): v for k, v in fake.calls[0]["headers"].items()}
    assert headers["authorization"] == "Bearer anon-from-settings"
    assert headers["x-cojo-api-key"] == "cj_demo"
    assert headers["apikey"] == "anon-from-settings"


def test_functions_proxy_preserves_caller_apikey(monkeypatch):
    monkeypatch.setattr(public_edge_proxy.settings, "supabase_url", "https://proj.supabase.co")
    monkeypatch.setattr(public_edge_proxy.settings, "supabase_anon_key", "anon-from-settings")
    fake = _FakeClient(_FakeResp(200, b"ok", {"content-type": "text/plain"}))

    with patch("app.routers.public_edge_proxy.httpx.AsyncClient", return_value=fake):
        client = _mount()
        res = client.get(
            "/functions/v1/scouts",
            headers={"apikey": "caller-apikey"},
        )

    assert res.status_code == 200
    assert res.text == "ok"
    assert fake.calls[0]["headers"]["apikey"] == "caller-apikey"


def test_mcp_proxy_serves_authorization_metadata_without_upstream(monkeypatch):
    monkeypatch.setattr(public_edge_proxy.settings, "supabase_url", "https://proj.supabase.co")
    monkeypatch.setattr(public_edge_proxy.settings, "supabase_anon_key", "anon-from-settings")
    fake = _FakeClient(_FakeResp(500, b"should-not-be-called"))

    with patch("app.routers.public_edge_proxy.httpx.AsyncClient", return_value=fake):
        client = _mount()
        res = client.get(
            "/mcp/.well-known/oauth-authorization-server",
            headers={
                "host": "scoutpost.ai",
                "x-forwarded-proto": "https",
            },
        )

    assert res.status_code == 200
    assert res.json()["issuer"] == "https://scoutpost.ai/mcp"
    assert res.json()["authorization_endpoint"] == "https://scoutpost.ai/mcp/authorize"
    assert res.json()["token_endpoint"] == "https://scoutpost.ai/mcp/token"
    assert res.json()["registration_endpoint"] == "https://scoutpost.ai/mcp/register"
    assert fake.calls == []
    assert res.headers["cache-control"] == "public, max-age=300"


def test_mcp_proxy_serves_protected_resource_metadata_without_upstream(monkeypatch):
    monkeypatch.setattr(public_edge_proxy.settings, "supabase_url", "https://proj.supabase.co")
    monkeypatch.setattr(public_edge_proxy.settings, "supabase_anon_key", "anon-from-settings")
    fake = _FakeClient(_FakeResp(500, b"should-not-be-called"))

    with patch("app.routers.public_edge_proxy.httpx.AsyncClient", return_value=fake):
        client = _mount()
        res = client.get(
            "/.well-known/oauth-protected-resource",
            headers={
                "host": "scoutpost.ai",
                "x-forwarded-proto": "https",
            },
        )

    assert res.status_code == 200
    assert res.json()["resource"] == "https://scoutpost.ai/mcp"
    assert res.json()["authorization_servers"] == ["https://scoutpost.ai/mcp"]
    assert res.json()["bearer_methods_supported"] == ["header"]
    assert res.json()["scopes_supported"] == ["mcp"]
    assert res.json()["resource_documentation"] == (
        "https://scoutpost.ai/skills/scoutpost.md"
    )
    assert fake.calls == []


def test_mcp_proxy_serves_authorization_metadata_at_path_suffixed_well_known(monkeypatch):
    """RFC 8414 §3 / RFC 9728 §3.1: clients append the resource path to the
    well-known URL when the resource lives below the host root. Anthropic's
    Cowork connect flow uses this form, so /.well-known/oauth-authorization-
    server/mcp must serve our AS metadata — without this, it falls through
    to the SvelteKit SPA and Anthropic gets HTML back, fails to parse, and
    aborts with start_error / 'Couldn't reach the MCP server'."""
    monkeypatch.setattr(public_edge_proxy.settings, "supabase_url", "https://proj.supabase.co")
    fake = _FakeClient(_FakeResp(500, b"should-not-be-called"))

    with patch("app.routers.public_edge_proxy.httpx.AsyncClient", return_value=fake):
        client = _mount()
        res = client.get(
            "/.well-known/oauth-authorization-server/mcp",
            headers={"host": "scoutpost.ai", "x-forwarded-proto": "https"},
        )

    assert res.status_code == 200
    assert res.headers["content-type"].startswith("application/json")
    assert res.json()["issuer"] == "https://scoutpost.ai/mcp"
    assert fake.calls == []


def test_mcp_proxy_serves_protected_resource_metadata_at_path_suffixed_well_known(monkeypatch):
    monkeypatch.setattr(public_edge_proxy.settings, "supabase_url", "https://proj.supabase.co")
    fake = _FakeClient(_FakeResp(500, b"should-not-be-called"))

    with patch("app.routers.public_edge_proxy.httpx.AsyncClient", return_value=fake):
        client = _mount()
        res = client.get(
            "/.well-known/oauth-protected-resource/mcp",
            headers={"host": "scoutpost.ai", "x-forwarded-proto": "https"},
        )

    assert res.status_code == 200
    assert res.headers["content-type"].startswith("application/json")
    assert res.json()["resource"] == "https://scoutpost.ai/mcp"
    assert fake.calls == []


@pytest.mark.parametrize(
    ("path", "field"),
    [
        ("/mcp/.well-known/oauth-authorization-server", "issuer"),
        ("/mcp/.well-known/oauth-protected-resource", "resource"),
        ("/.well-known/oauth-authorization-server/mcp", "issuer"),
        ("/.well-known/oauth-protected-resource/mcp", "resource"),
    ],
)
def test_mcp_metadata_uses_canonical_base_when_forwarded_host_is_spoofed(
    monkeypatch,
    path,
    field,
):
    monkeypatch.setattr(public_edge_proxy.settings, "supabase_url", "https://proj.supabase.co")
    monkeypatch.setattr(public_edge_proxy.settings, "public_mcp_base_url", "https://scoutpost.ai/mcp")
    fake = _FakeClient(_FakeResp(500, b"should-not-be-called"))

    with patch("app.routers.public_edge_proxy.httpx.AsyncClient", return_value=fake):
        client = _mount()
        res = client.get(
            path,
            headers={
                "host": "scoutpost.ai",
                "x-forwarded-host": "evil.example",
                "x-forwarded-proto": "https",
            },
        )

    assert res.status_code == 200
    body = res.json()
    assert body[field] == "https://scoutpost.ai/mcp"
    assert "evil.example" not in str(body)
    assert fake.calls == []


def test_mcp_proxy_path_suffixed_well_known_404s_for_non_mcp_resource(monkeypatch):
    """Belt-and-braces: only honour requests whose tail matches our /mcp
    surface so we don't accidentally advertise OAuth metadata for any
    arbitrary path. Other resources should 404 cleanly (not return SPA HTML)."""
    monkeypatch.setattr(public_edge_proxy.settings, "supabase_url", "https://proj.supabase.co")

    client = _mount()
    res = client.get(
        "/.well-known/oauth-protected-resource/some-other-thing",
        headers={"host": "scoutpost.ai", "x-forwarded-proto": "https"},
    )
    assert res.status_code == 404


def test_proxy_returns_sterile_502_on_upstream_error(monkeypatch):
    monkeypatch.setattr(public_edge_proxy.settings, "supabase_url", "https://proj.supabase.co")

    class _BrokenClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def request(self, *args, **kwargs):
            raise httpx.ConnectError("secret-infra-detail")

    with patch("app.routers.public_edge_proxy.httpx.AsyncClient", return_value=_BrokenClient()):
        client = _mount()
        res = client.get("/functions/v1/openapi-spec")

    assert res.status_code == 502
    assert res.json() == {"detail": "Upstream unavailable"}


def test_validate_supabase_base_rejects_non_supabase_host():
    with pytest.raises(RuntimeError, match="supabase"):
        public_edge_proxy._validate_supabase_base("https://evil.example/functions/v1")


def test_validate_supabase_base_accepts_localhost_http():
    public_edge_proxy._validate_supabase_base("http://127.0.0.1:54321")

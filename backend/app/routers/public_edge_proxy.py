"""
Public broker proxy for Supabase Edge Functions and MCP.

Why this exists:
The hosted product advertises same-origin agent endpoints on scoutpost.ai:

  - /functions/v1/*  -> public REST / OpenAPI surface
  - /mcp*            -> remote MCP + OAuth discovery surface

The real handlers live in Supabase Edge Functions. This proxy keeps the public
contract stable, injects the public anon key server-side when needed, and
avoids sending users to raw project URLs for normal hosted usage.

Security model:
  - Upstream host is fixed from SUPABASE_URL and validated at startup/lazy use.
  - Authorization is forwarded verbatim.
  - cj_ API keys are moved to X-Cojo-Api-Key and Authorization is replaced
    with the anon JWT before forwarding to Supabase, so Kong does not reject
    the non-JWT bearer before the Edge Function can validate it.
  - apikey is forwarded when provided, otherwise populated from
    SUPABASE_ANON_KEY for hosted same-origin calls.
  - Hop-by-hop headers are stripped.
"""

from __future__ import annotations

import logging
import os
import json
from typing import Any
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response

from app.config import settings

logger = logging.getLogger(__name__)

router = APIRouter()

_ALLOWED_SUPABASE_HOSTS = ("supabase.co", "supabase.in")
_LOCAL_HOSTS = {"127.0.0.1", "localhost"}
_TIMEOUT = httpx.Timeout(connect=5.0, read=30.0, write=15.0, pool=5.0)

_STRIP_HEADERS = {
    "host",
    "content-length",
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}

_RELAY_RESPONSE_HEADERS = {
    "content-type",
    "cache-control",
    "location",
    "www-authenticate",
    "content-disposition",
}


def _validate_supabase_base(url: str) -> None:
    parsed = urlparse(url)
    if not parsed.hostname:
        raise RuntimeError(f"SUPABASE_URL must include a hostname; got {url!r}")
    if parsed.hostname in _LOCAL_HOSTS:
        if parsed.scheme != "http":
            raise RuntimeError(
                "Local SUPABASE_URL must be http://localhost or "
                f"http://127.0.0.1; got {url!r}",
            )
        return
    if parsed.scheme != "https":
        raise RuntimeError(f"SUPABASE_URL must use https; got {url!r}")
    if not any(
        parsed.hostname == host or parsed.hostname.endswith("." + host)
        for host in _ALLOWED_SUPABASE_HOSTS
    ):
        raise RuntimeError(
            "SUPABASE_URL must point at supabase.co/.in for hosted mode; "
            f"got {url!r}",
        )


def _supabase_base() -> str:
    base = (settings.supabase_url or os.getenv("SUPABASE_URL") or "").rstrip("/")
    if not base:
        raise HTTPException(status_code=503, detail="Supabase broker unavailable")
    try:
        _validate_supabase_base(base)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return base


def _upstream_url(prefix: str, path: str, query: str) -> str:
    base = _supabase_base()
    prefix = prefix.strip("/")
    path = path.strip("/")
    url = f"{base}/{prefix}"
    if path:
        url = f"{url}/{path}"
    if query:
        url = f"{url}?{query}"
    return url


def _forward_headers(request: Request) -> dict[str, str]:
    headers = {
        key: value
        for key, value in request.headers.items()
        if key.lower() not in _STRIP_HEADERS
    }
    auth_key = next((key for key in headers if key.lower() == "authorization"), None)
    if auth_key and headers[auth_key].lower().startswith("bearer cj_"):
        token = headers[auth_key].split(None, 1)[1].strip()
        headers["x-cojo-api-key"] = token
        if settings.supabase_anon_key:
            headers[auth_key] = f"Bearer {settings.supabase_anon_key}"
    if "apikey" not in {key.lower() for key in headers} and settings.supabase_anon_key:
        headers["apikey"] = settings.supabase_anon_key
    return headers


def _response_headers(upstream: httpx.Response) -> dict[str, str]:
    headers: dict[str, str] = {}
    for key, value in upstream.headers.items():
        lower = key.lower()
        if (
            lower in _RELAY_RESPONSE_HEADERS
            or lower.startswith("x-")
            or lower.startswith("mcp-")
        ):
            headers[key] = value
    return headers


def _public_mcp_base(request: Request) -> str:
    proto = (
        request.headers.get("x-forwarded-proto")
        or request.url.scheme
        or "https"
    ).split(",")[0].strip()
    host = (
        request.headers.get("x-forwarded-host")
        or request.headers.get("host")
        or request.url.netloc
    ).split(",")[0].strip()
    return f"{proto}://{host}/mcp".rstrip("/")


def _mcp_authorization_metadata(request: Request) -> JSONResponse:
    public_base = _public_mcp_base(request)
    return JSONResponse(
        {
            "issuer": public_base,
            "authorization_endpoint": f"{public_base}/authorize",
            "token_endpoint": f"{public_base}/token",
            "registration_endpoint": f"{public_base}/register",
            "response_types_supported": ["code"],
            "grant_types_supported": ["authorization_code", "refresh_token"],
            "code_challenge_methods_supported": ["S256"],
            "token_endpoint_auth_methods_supported": ["none", "client_secret_post"],
            "scopes_supported": ["mcp"],
        },
        headers={"Cache-Control": "public, max-age=300"},
    )


def _mcp_protected_resource_metadata(request: Request) -> JSONResponse:
    public_base = _public_mcp_base(request)
    return JSONResponse(
        {
            "resource": public_base,
            "authorization_servers": [public_base],
            "bearer_methods_supported": ["header"],
            "scopes_supported": ["mcp"],
            "resource_documentation": (
                "https://www.scoutpost.ai/skills/scoutpost.md"
            ),
        },
        headers={"Cache-Control": "public, max-age=300"},
    )


def _rewrite_mcp_metadata(
    request: Request,
    path: str,
    upstream: httpx.Response,
) -> Response | None:
    if upstream.status_code != 200:
        return None
    normalized = "/" + path.strip("/")
    if normalized not in {
        "/.well-known/oauth-authorization-server",
        "/.well-known/oauth-protected-resource",
    }:
        return None
    content_type = upstream.headers.get("content-type", "")
    if "json" not in content_type.lower():
        return None
    try:
        body: dict[str, Any] = json.loads(upstream.content.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None

    public_base = _public_mcp_base(request)
    if normalized.endswith("oauth-authorization-server"):
        body["issuer"] = public_base
        body["authorization_endpoint"] = f"{public_base}/authorize"
        body["token_endpoint"] = f"{public_base}/token"
        body["registration_endpoint"] = f"{public_base}/register"
    else:
        body["resource"] = public_base
        body["authorization_servers"] = [public_base]
        body.setdefault("bearer_methods_supported", ["header"])
        body.setdefault("scopes_supported", ["mcp"])
        body["resource_documentation"] = (
            "https://www.scoutpost.ai/skills/scoutpost.md"
        )

    return JSONResponse(
        body,
        status_code=upstream.status_code,
        headers=_response_headers(upstream),
    )


async def _proxy(request: Request, upstream_url: str) -> Response:
    body = await request.body()
    try:
        async with httpx.AsyncClient(
            timeout=_TIMEOUT,
            follow_redirects=False,
        ) as client:
            upstream = await client.request(
                request.method,
                upstream_url,
                content=body or None,
                headers=_forward_headers(request),
            )
    except httpx.HTTPError:
        logger.exception("public_edge_proxy upstream unreachable: %s", upstream_url)
        raise HTTPException(status_code=502, detail="Upstream unavailable")

    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        headers=_response_headers(upstream),
    )


@router.api_route(
    "/functions/v1/{path:path}",
    methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS", "HEAD"],
    include_in_schema=False,
)
async def proxy_edge_functions(path: str, request: Request) -> Response:
    upstream_url = _upstream_url("functions/v1", path, request.url.query)
    return await _proxy(request, upstream_url)


@router.api_route(
    "/.well-known/oauth-authorization-server",
    methods=["GET", "HEAD"],
    include_in_schema=False,
)
async def proxy_root_mcp_authorization_metadata(request: Request) -> Response:
    return _mcp_authorization_metadata(request)


@router.api_route(
    "/.well-known/oauth-protected-resource",
    methods=["GET", "HEAD"],
    include_in_schema=False,
)
async def proxy_root_mcp_protected_resource_metadata(request: Request) -> Response:
    return _mcp_protected_resource_metadata(request)


# RFC 9728 §3.1 / RFC 8414 §3 path-suffixed well-known URLs.
# Resources / authorization servers exposed at https://host/<path> publish
# their metadata at https://host/.well-known/oauth-{protected-resource,
# authorization-server}/<path>. Anthropic's connect flow follows RFC 9728
# strictly, so /.well-known/oauth-protected-resource/mcp must serve the
# protected-resource JSON for our /mcp surface — without this handler the
# request falls through to the SvelteKit SPA and Anthropic gets HTML +
# 200, fails to parse, and shows "Couldn't reach the MCP server"
# (start_error). We accept any tail path that begins with our /mcp prefix
# and serve the same body the unsuffixed form returns.
@router.api_route(
    "/.well-known/oauth-authorization-server/{tail:path}",
    methods=["GET", "HEAD"],
    include_in_schema=False,
)
async def proxy_path_mcp_authorization_metadata(
    tail: str,
    request: Request,
) -> Response:
    if not _is_mcp_well_known_tail(tail):
        raise HTTPException(status_code=404, detail="not found")
    return _mcp_authorization_metadata(request)


@router.api_route(
    "/.well-known/oauth-protected-resource/{tail:path}",
    methods=["GET", "HEAD"],
    include_in_schema=False,
)
async def proxy_path_mcp_protected_resource_metadata(
    tail: str,
    request: Request,
) -> Response:
    if not _is_mcp_well_known_tail(tail):
        raise HTTPException(status_code=404, detail="not found")
    return _mcp_protected_resource_metadata(request)


def _is_mcp_well_known_tail(tail: str) -> bool:
    # Only honour requests that match our published MCP base path. Anything
    # else stays a 404 so we don't accidentally advertise OAuth metadata
    # for some other surface.
    normalised = "/" + tail.strip("/")
    return normalised in {"/mcp"} or normalised.startswith("/mcp/")


@router.api_route(
    "/mcp",
    methods=["GET", "POST", "OPTIONS", "HEAD"],
    include_in_schema=False,
)
async def proxy_mcp_root(request: Request) -> Response:
    upstream_url = _upstream_url("functions/v1/mcp-server", "", request.url.query)
    return await _proxy(request, upstream_url)


@router.api_route(
    "/mcp/{path:path}",
    methods=["GET", "POST", "OPTIONS", "HEAD"],
    include_in_schema=False,
)
async def proxy_mcp_path(path: str, request: Request) -> Response:
    normalized = "/" + path.strip("/")
    if normalized == "/.well-known/oauth-authorization-server":
        return _mcp_authorization_metadata(request)
    if normalized == "/.well-known/oauth-protected-resource":
        return _mcp_protected_resource_metadata(request)

    upstream_url = _upstream_url("functions/v1/mcp-server", path, request.url.query)
    body = await request.body()
    try:
        async with httpx.AsyncClient(
            timeout=_TIMEOUT,
            follow_redirects=False,
        ) as client:
            upstream = await client.request(
                request.method,
                upstream_url,
                content=body or None,
                headers=_forward_headers(request),
            )
    except httpx.HTTPError:
        logger.exception("public_edge_proxy upstream unreachable: %s", upstream_url)
        raise HTTPException(status_code=502, detail="Upstream unavailable")

    rewritten = _rewrite_mcp_metadata(request, path, upstream)
    if rewritten is not None:
        return rewritten
    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        headers=_response_headers(upstream),
    )

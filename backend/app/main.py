"""
FastAPI main application entry point.

PURPOSE: Creates the FastAPI app, configures CORS middleware, rate limiting
(slowapi), mounts all routers under /api prefix, and serves the SvelteKit
SPA static build.

DEPENDS ON: config (settings), all routers (mounted here)
USED BY: Render deployment (uvicorn entrypoint)
"""
import logging
import os
import re
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import quote

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
# Starlette's HTTPException is the base class — StaticFiles raises this
# (not FastAPI's subclass), so catch the parent to cover both.
from starlette.exceptions import HTTPException
from starlette.responses import Response
from starlette.types import Scope

from app.config import settings

class SensitiveDataFilter(logging.Filter):
    """Scrub API keys, tokens, and JWTs from log output."""
    PATTERNS = [re.compile(p) for p in [
        r'(sk-[a-zA-Z0-9]{20,})',        # OpenRouter/API keys
        r'(cj_[a-zA-Z0-9]+)',             # coJournalist API keys
        r'(Bearer\s+[a-zA-Z0-9._-]{20,})',  # Bearer tokens
        r'(eyJ[a-zA-Z0-9._-]{20,})',      # JWTs
        r'(AKIA[A-Z0-9]{16})',            # AWS access keys
    ]]

    def filter(self, record):
        if isinstance(record.msg, str):
            for pat in self.PATTERNS:
                record.msg = pat.sub('[REDACTED]', record.msg)
        if record.args:
            args = list(record.args) if isinstance(record.args, tuple) else [record.args]
            for i, arg in enumerate(args):
                if isinstance(arg, str):
                    for pat in self.PATTERNS:
                        args[i] = pat.sub('[REDACTED]', args[i])
            record.args = tuple(args)
        return True


# Configure logging
log_level = logging.DEBUG if settings.environment == "development" else logging.INFO
logging.basicConfig(
    level=log_level,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout)
    ]
)
logging.getLogger().addFilter(SensitiveDataFilter())

logger = logging.getLogger(__name__)

FRONTEND_DIST = Path(__file__).resolve().parent / "frontend_client"
PUBLIC_MARKDOWN_FILES = {
    "/": "overview.txt",
    "/login": "overview.txt",
    "/docs": "docs.txt",
    "/pricing": "pricing.txt",
    "/faq": "faq.txt",
    "/skills": "skills.txt",
}
PUBLIC_SKILL_FILES = {
    "scoutpost.md": "skills/scoutpost.md",
    "scoutpost-setup.md": "skills/scoutpost-setup.md",
    # Legacy aliases for agents or docs cached before the Scoutpost rename.
    "cojournalist.md": "skills/scoutpost.md",
    "cojournalist-setup.md": "skills/scoutpost-setup.md",
}


def _frontend_file(path: str) -> Path:
    return FRONTEND_DIST / path


_SPA_NO_CACHE_HEADERS = {"cache-control": "no-cache, must-revalidate"}
# Content-hashed SvelteKit assets under /_app/immutable/ are safe to cache
# forever — a new deploy generates new filenames, so a stale cache entry
# never aliases to new content. We stamp an explicit 1-year max-age +
# `immutable` so CF's default 4h browser TTL is defeated and browsers skip
# revalidation entirely during the window.
_IMMUTABLE_ASSET_HEADERS = {
    "cache-control": "public, max-age=31536000, immutable"
}
_NO_STORE_HEADERS = {"cache-control": "no-store"}
# Email templates reference images via /static/<file>.png so Resend can fetch
# them at send time. Only image extensions at the static root are served;
# everything else 404s so /static/ can't be abused as a backdoor to serve
# _app/immutable/*, index.html, text resources, or arbitrary build artifacts.
_EMAIL_ASSET_EXTENSIONS = frozenset(
    {".png", ".svg", ".jpg", ".jpeg", ".gif", ".webp", ".ico"}
)
_EMAIL_ASSET_HEADERS = {"cache-control": "public, max-age=86400"}
_MARKDOWN_CACHE_HEADERS = {"cache-control": "no-cache, must-revalidate"}
_CANONICAL_REDIRECT_HOSTS = {
    "cojournalist.ai",
    "www.cojournalist.ai",
    "www.scoutpost.ai",
}
_CANONICAL_PUBLIC_HOST = "scoutpost.ai"


def _is_asset_path(path: str) -> bool:
    """True when a path looks like a static asset (non-.html extension).

    Missing asset paths MUST return 404, never a SPA HTML fallback — a
    `text/html` response for `.js`/`.css`/etc. trips the browser's module
    MIME guard and blanks the page.
    """
    last_segment = path.rsplit("/", 1)[-1]
    if "." not in last_segment:
        return False
    return not last_segment.lower().endswith(".html")


def _serve_frontend_index() -> Response:
    index_path = _frontend_file("index.html")
    if not index_path.exists():
        return Response(status_code=404)
    return FileResponse(index_path, headers=_SPA_NO_CACHE_HEADERS)


def _serve_frontend_route(path: str) -> Response:
    if path == "/":
        return _serve_frontend_index()

    # adapter-static writes prerendered routes as <route>.html, or as
    # <route>/index.html when a static directory of the same name exists.
    route = path.strip("/")
    for route_path in (_frontend_file(f"{route}.html"), _frontend_file(f"{route}/index.html")):
        if route_path.is_file():
            return FileResponse(route_path, headers=_SPA_NO_CACHE_HEADERS)

    return _serve_frontend_index()


def _serve_markdown(path: str) -> Response:
    markdown_path = _frontend_file(path)
    if not markdown_path.exists():
        return Response(status_code=404)
    response = FileResponse(markdown_path, media_type="text/markdown")
    response.headers["Vary"] = "Accept"
    # Markdown representations (`.txt` files served as text/markdown via the
    # Accept-negotiated public routes) change every deploy — same reasoning
    # as index.html: force revalidation so CF's default 4h browser TTL can't
    # pin stale content after a rebuild.
    response.headers["cache-control"] = _MARKDOWN_CACHE_HEADERS["cache-control"]
    return response


def _wants_markdown(request: Request) -> bool:
    accept = (request.headers.get("accept") or "").lower()
    return "text/markdown" in accept

# Rate limiter configuration. Behind Cloudflare, `get_remote_address` returns
# the CF edge IP, which lumps every real client into the same bucket. Trust
# `CF-Connecting-IP` only when `CF-Ray` proves the hop actually came through
# Cloudflare; otherwise fall back to the transport-level client.
def _client_ip_key(request: Request) -> str:
    if request.headers.get("cf-ray"):
        cf_client = request.headers.get("cf-connecting-ip")
        if cf_client:
            return cf_client
    return get_remote_address(request)


limiter = Limiter(key_func=_client_ip_key)


class SPAStaticFiles(StaticFiles):
    """Serve the SvelteKit build with correct SPA-vs-asset semantics.

    - /api/* paths no router matched are 404 JSON, never the SPA shell.
    - Missing asset files (anything with a non-.html extension) return 404 so
      the browser's module MIME guard never sees HTML in place of JS/CSS/etc.
    - Missing SPA routes (no extension, or .html) serve index.html with a
      no-cache header so a subsequent deploy can't leave the browser pinned
      to stale, now-missing hashed asset references.
    - Successful index.html responses also get no-cache (covers the html=True
      directory-index case for "/" and similar).
    """

    async def get_response(self, path: str, scope: Scope) -> Response:
        if path.startswith("api/"):
            return JSONResponse(
                {"detail": "Not Found"}, status_code=404, headers=_NO_STORE_HEADERS
            )

        try:
            response = await super().get_response(path, scope)
        except HTTPException as exc:
            # 404 is the expected "file not found" case — apply our
            # SPA-vs-asset fallback logic. Any other HTTP status (401 for
            # permission errors, 405 for non-GET, etc.) should pass through
            # unchanged so the real error surfaces.
            if exc.status_code != 404:
                raise
            if _is_asset_path(path):
                return Response(status_code=404, headers=_NO_STORE_HEADERS)
            # Prerendered routes (adapter-static writes /terms as terms.html)
            # must reach crawlers as real HTML, not the empty SPA shell.
            prerendered = self._prerendered_page(path)
            if prerendered:
                return FileResponse(prerendered, headers=_SPA_NO_CACHE_HEADERS)
            index_path = os.path.join(self.directory, "index.html")
            if not os.path.exists(index_path):
                return Response(status_code=404, headers=_NO_STORE_HEADERS)
            return FileResponse(index_path, headers=_SPA_NO_CACHE_HEADERS)

        if response.status_code == 200:
            if path.startswith("_app/immutable/"):
                response.headers["cache-control"] = _IMMUTABLE_ASSET_HEADERS[
                    "cache-control"
                ]
            else:
                served_path = getattr(response, "path", "")
                if str(served_path).endswith("index.html"):
                    response.headers["cache-control"] = "no-cache, must-revalidate"
        return response


    def _prerendered_page(self, path: str) -> str | None:
        route = path.strip("/")
        if not route or "." in route.rsplit("/", 1)[-1]:
            return None
        root = os.path.realpath(self.directory)
        candidate = os.path.realpath(os.path.join(root, f"{route}.html"))
        if not candidate.startswith(root + os.sep) or not os.path.isfile(candidate):
            return None
        return candidate


class EmailStaticFiles(StaticFiles):
    """Tight static mount for email images only.

    Email templates (e.g. license-key onboarding) embed images via absolute
    URLs like `https://scoutpost.ai/static/logo-cojournalist.png` so
    Resend can fetch them at send time. Only allow image files at the root
    of the static directory — no subdirectories, no `.html`, no `.txt`, no
    hashed bundles under `_app/immutable/`. This prevents the `/static/`
    mount from duplicating the SvelteKit build surface.
    """

    async def get_response(self, path: str, scope: Scope) -> Response:
        if "/" in path or ".." in path:
            return Response(status_code=404, headers=_NO_STORE_HEADERS)
        ext = os.path.splitext(path)[1].lower()
        if ext not in _EMAIL_ASSET_EXTENSIONS:
            return Response(status_code=404, headers=_NO_STORE_HEADERS)
        try:
            response = await super().get_response(path, scope)
        except HTTPException as exc:
            if exc.status_code == 404:
                return Response(status_code=404, headers=_NO_STORE_HEADERS)
            raise
        if response.status_code == 200:
            response.headers["cache-control"] = _EMAIL_ASSET_HEADERS[
                "cache-control"
            ]
        return response


@asynccontextmanager
async def lifespan(_: FastAPI):
    """Log startup configuration and shutdown."""
    logger.info("=" * 50)
    logger.info("🚀 coJournalist API Starting...")
    logger.info(f"App Name: {settings.app_name}")
    logger.info(f"Environment: {settings.environment}")
    logger.info(f"Debug Mode: {settings.debug}")
    logger.info(f"MuckRock OAuth: {'Configured' if settings.muckrock_client_id else 'Not configured'}")
    logger.info(f"Default Credits: {settings.default_credits}")
    logger.info(f"Default Timezone: {settings.default_timezone}")
    logger.info("=" * 50)
    logger.info("Application startup complete")

    try:
        yield
    finally:
        logger.info("Application shutdown complete")


# Create FastAPI app
app = FastAPI(
    title="coJournalist API",
    description="Public REST API for programmatic access to coJournalist — create scouts and retrieve information units.",
    version="1.0.0",
    debug=settings.debug,
    lifespan=lifespan,
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
)

# Configure rate limiter
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    # Only add CSP to HTML responses (don't break API JSON responses)
    content_type = response.headers.get("content-type", "")
    if "text/html" in content_type:
        script_src = ["'self'", "'unsafe-inline'"]
        style_src = ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"]
        frame_src = (
            ["https://www.youtube-nocookie.com"]
            if request.url.path == "/login"
            else ["'none'"]
        )
        if request.url.path == "/swagger" or request.url.path.startswith("/swagger/"):
            script_src.append("https://unpkg.com")
            style_src.append("https://unpkg.com")
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            f"script-src {' '.join(script_src)}; "
            f"style-src {' '.join(style_src)}; "
            "img-src 'self' https: data:; "
            "font-src 'self' https://fonts.gstatic.com; "
            "connect-src 'self' https://*.maptiler.com https://*.supabase.co; "
            f"frame-src {' '.join(frame_src)}"
        )
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    # Don't leak full referer (including path + query) to cross-origin links
    # or resources. Scout URLs, feedback tokens, and similar can appear in
    # the path — keep them same-origin.
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    return response


async def _add_no_store_on_error_responses(request: Request, call_next):
    """Stamp `cache-control: no-store` on any response with status >= 400
    that doesn't already carry an explicit cache-control.

    Cloudflare fills missing cache-control with a 4h default browser TTL.
    That means a transient 500, a 404, or an HTTPException can get pinned
    at CF edge and in the user's browser for hours — locking users out
    until the TTL expires even after the underlying issue is fixed. This
    middleware closes that window globally.

    Also catches exceptions that escape past ExceptionMiddleware (e.g. if
    the global_exception_handler itself raises, or a handler isn't
    registered) and converts them to a 500 response stamped with
    no-store. ServerErrorMiddleware would otherwise produce a 500 that
    bypasses this middleware entirely, leaving it without cache headers.
    """
    try:
        response = await call_next(request)
    except Exception:
        logger.exception("Unhandled exception escaped to no-store middleware")
        return JSONResponse(
            status_code=500,
            content={"error": "Internal server error"},
            headers=_NO_STORE_HEADERS,
        )
    if response.status_code >= 400 and "cache-control" not in response.headers:
        response.headers["cache-control"] = "no-store"
    return response


app.middleware("http")(_add_no_store_on_error_responses)


@app.middleware("http")
async def redirect_to_canonical_host(request: Request, call_next):
    """Permanently move legacy and www traffic to canonical Scoutpost apex."""
    raw_host = request.headers.get("host", "")
    host = raw_host.split(":", 1)[0].lower()
    if host in _CANONICAL_REDIRECT_HOSTS:
        path = quote(request.url.path, safe="/%")
        query = f"?{request.url.query}" if request.url.query else ""
        return Response(
            status_code=308,
            headers={"location": f"https://{_CANONICAL_PUBLIC_HOST}{path}{query}"},
        )
    return await call_next(request)


@app.middleware("http")
async def normalize_api_prefix(request: Request, call_next):
    """
    Temporary workaround: older frontend bundles may still call /api/api/*.
    Normalize those paths so the actual /api routes handle them instead of returning 500.
    """
    path = request.scope.get("path", "")
    if path.startswith("/api/api"):
        new_path = path.replace("/api/api", "/api", 1)
        request.scope["path"] = new_path

        raw_path = request.scope.get("raw_path")
        if isinstance(raw_path, (bytes, bytearray)):
            request.scope["raw_path"] = raw_path.replace(b"/api/api", b"/api", 1)

        logger.debug("Normalized duplicated API prefix: %s -> %s", path, new_path)

    return await call_next(request)


# Production auth lives in Supabase Edge Functions, but local dev can mount a
# small FastAPI MuckRock broker so localhost can authenticate against hosted
# data before deploy. Production still uses the MuckRock compatibility proxy to
# keep the registered callback + webhook URLs stable.
from app.routers import public_edge_proxy
# Public broker for the hosted REST + MCP surface. Separate from /api/auth/*
# so it cannot intercept the MuckRock webhook/callback flow.
app.include_router(public_edge_proxy.router, include_in_schema=False)
# scouts, beat, social, civic, scraper, data_extractor, v1, onboarding, user,
# and units routers removed after the Supabase Edge Functions cutover. Scout
# scheduling/execution, user preferences, units, and the public REST API live
# in supabase/functions/.

# Feedback — hidden from public API docs


@app.api_route("/", methods=["GET", "HEAD"], include_in_schema=False)
async def public_root(request: Request):
    if _wants_markdown(request):
        return _serve_markdown(PUBLIC_MARKDOWN_FILES["/"])
    return _serve_frontend_route("/")


@app.api_route("/login", methods=["GET", "HEAD"], include_in_schema=False)
async def public_login(request: Request):
    if _wants_markdown(request):
        return _serve_markdown(PUBLIC_MARKDOWN_FILES["/login"])
    return _serve_frontend_route("/login")


@app.api_route("/docs", methods=["GET", "HEAD"], include_in_schema=False)
async def public_docs(request: Request):
    if _wants_markdown(request):
        return _serve_markdown(PUBLIC_MARKDOWN_FILES["/docs"])
    return _serve_frontend_route("/docs")


@app.api_route("/pricing", methods=["GET", "HEAD"], include_in_schema=False)
async def public_pricing(request: Request):
    if _wants_markdown(request):
        return _serve_markdown(PUBLIC_MARKDOWN_FILES["/pricing"])
    return _serve_frontend_route("/pricing")


@app.api_route("/faq", methods=["GET", "HEAD"], include_in_schema=False)
async def public_faq(request: Request):
    if _wants_markdown(request):
        return _serve_markdown(PUBLIC_MARKDOWN_FILES["/faq"])
    return _serve_frontend_route("/faq")


@app.api_route("/skills", methods=["GET", "HEAD"], include_in_schema=False)
async def public_skills(request: Request):
    if _wants_markdown(request):
        return _serve_markdown(PUBLIC_MARKDOWN_FILES["/skills"])
    return _serve_frontend_route("/skills")


@app.api_route("/skills/{filename:path}", methods=["GET", "HEAD"], include_in_schema=False)
async def public_skill_file(filename: str):
    markdown_path = PUBLIC_SKILL_FILES.get(filename.strip("/"))
    if markdown_path is None:
        return Response(status_code=404)
    return _serve_markdown(markdown_path)


@app.api_route("/swagger", methods=["GET", "HEAD"], include_in_schema=False)
async def public_swagger():
    return _serve_frontend_route("/swagger")


@app.api_route("/skill.md", methods=["GET", "HEAD"], include_in_schema=False)
async def public_legacy_skill():
    return _serve_markdown("skill.md")




# Health check endpoints — MUST be declared BEFORE the SPA static mount
# below, otherwise the mount catches /api/health and answers 404. Render's
# healthCheckPath is /api/health so a regression here makes the deploy
# immediately unhealthy.
@app.get("/api/health", include_in_schema=False)
async def health_check():
    """Health check endpoint for monitoring."""
    return {"status": "healthy", "service": settings.app_name}


@app.get("/api/ready", include_in_schema=False)
async def readiness_check():
    """Readiness check endpoint."""
    return {"status": "ready"}


# Serve built frontend if available
if FRONTEND_DIST.exists():
    logger.info("Serving frontend assets from %s", FRONTEND_DIST)
    # Restricted mount for email-embedded images (root-level image files only).
    # See EmailStaticFiles for the allowlist — prevents /static/* from being
    # an alternate path to the SPA build surface.
    app.mount("/static", EmailStaticFiles(directory=str(FRONTEND_DIST)), name="static")
    # SPA fallback for all other routes
    app.mount("/", SPAStaticFiles(directory=str(FRONTEND_DIST), html=True), name="frontend")
else:
    logger.info("Frontend assets directory not found at %s (skipping mount).", FRONTEND_DIST)


# Global exception handler
@app.exception_handler(Exception)
async def global_exception_handler(request, exc):
    """Global exception handler for unhandled errors."""
    # Log full exception server-side for debugging
    logger.exception(f"Unhandled exception: {exc}")
    # Return generic error to client (no internal details)
    return JSONResponse(
        status_code=500,
        content={"error": "Internal server error"},
        headers=_NO_STORE_HEADERS,
    )

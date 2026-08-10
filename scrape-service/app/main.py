"""Scoutpost scrape-service — self-hosted replacement for Firecrawl scrape +
PDF parse (SCRAPING-MIGRATION-PRD, U1).

Endpoints:
  POST /scrape — Playwright render via the Crawl4AI library; returns the
                 ScrapeResult shape the edge functions consume (KTD2 mapping).
  POST /parse  — PDF URL → deterministic text via poppler pdftotext, with a
                 density guard surfacing scanned docs as `needs_ocr`.
  GET  /health — unauthenticated (Render health checks cannot send headers).

Error taxonomy mirrors the Deno adapter contract: upstream render/parse
failure → 502, timeout → 504, scanned PDF → 422 {"error": "needs_ocr"},
oversized PDF → 413, non-PDF → 415, bad token → 401.
"""

import asyncio
import json
import logging
import secrets as secrets_mod
from contextlib import AsyncExitStack, asynccontextmanager, suppress
from datetime import datetime, timezone
from urllib.parse import urlparse

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field

from .config import Settings, load_settings
from .crawl_runner import CrawlResultError, execute_crawl
from .network_policy import guarded_egress
from .openrouter_pdf import (
    OPENROUTER_INLINE_MAX_BYTES,
    OpenRouterParseError,
    transcribe_pdf,
)
from .pdfparse import (
    NeedsOcrError,
    NotAPdfError,
    PdfDownloadError,
    PdfTimeoutError,
    PdfTooLargeError,
    PrivateAddressError,
    assert_public_host,
    parse_pdf_url,
)
from .scraper import Scraper

_bearer = HTTPBearer(auto_error=False)
# Uvicorn configures this logger's INFO handler in production. A standalone
# application logger would otherwise be dropped by Uvicorn's logging config.
_operation_log = logging.getLogger("uvicorn.error")
_workload_classes = frozenset({"scout", "utility", "system"})


def record_operation(operation: str, workload_class: str) -> None:
    """Emit only the content-free fields used to size Gate B traffic."""
    if workload_class not in _workload_classes:
        raise ValueError("invalid workload class")
    _operation_log.info(
        json.dumps(
            {
                "minute": datetime.now(timezone.utc)
                .replace(second=0, microsecond=0)
                .isoformat(),
                "operation": operation,
                "workload_class": workload_class,
            },
            separators=(",", ":"),
        )
    )


async def emit_operation_heartbeats() -> None:
    """Prove every minute of the content-free arrival window is observable."""
    while True:
        record_operation("heartbeat", "system")
        now = datetime.now(timezone.utc)
        # Wake inside the next minute, not on its boundary. Otherwise the log
        # timestamp can advance before the separately sampled bucket timestamp.
        await asyncio.sleep(61 - now.second - now.microsecond / 1_000_000)


def create_app(settings: Settings | None = None) -> FastAPI:
    resolved = settings if settings is not None else load_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        heartbeat = asyncio.create_task(emit_operation_heartbeats())
        async with AsyncExitStack() as stack:
            proxy_server: str | None = None
            if resolved.block_private_addresses:
                egress = await stack.enter_async_context(guarded_egress())
                proxy_server = egress.proxy_url
                app.state.egress_stats = egress.stats
            # Tests replace the scraper with a fake before entering lifespan;
            # preserve that seam. Production's cold Scraper is recreated with
            # the DNS-pinning proxy before its first browser launch.
            if isinstance(app.state.scraper, Scraper):
                app.state.scraper = Scraper(
                    pool_size=resolved.browser_pool_size,
                    proxy_server=proxy_server,
                )
            try:
                yield
            finally:
                heartbeat.cancel()
                with suppress(asyncio.CancelledError):
                    await heartbeat
                await app.state.scraper.close()
                await app.state.http_client.aclose()

    # No unauthenticated surfaces on an internet-facing arbitrary-URL renderer:
    # docs/redoc/openapi are disabled outright.
    app = FastAPI(
        title="scoutpost-scrape-service",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.settings = resolved
    app.state.scraper = Scraper(pool_size=resolved.browser_pool_size)
    # Bound ingress separately from the crawler's internal browser semaphore.
    # Excess work previously waited behind the two browser slots until callers
    # disconnected. Snapshot capture gets an independent single admission slot
    # so an archive batch cannot consume ordinary scrape capacity.
    app.state.scrape_slots = asyncio.Semaphore(resolved.browser_pool_size)
    app.state.snapshot_slot = asyncio.Semaphore(1)
    # Browser-grade UA: council/document hosts 403 library-default agents
    # (observed on the U1 smoke). Firecrawl's fetcher presented a browser UA,
    # so this is behavioral parity for the PDF download path.
    app.state.http_client = httpx.AsyncClient(
        headers={
            "user-agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/126.0.0.0 Safari/537.36"
            )
        }
    )

    def require_token(
        request: Request,
        credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    ) -> None:
        cfg: Settings = request.app.state.settings
        if cfg.token is None:
            return  # anon mode was explicitly opted into at startup
        if credentials is None or not secrets_mod.compare_digest(
            credentials.credentials, cfg.token
        ):
            raise HTTPException(status_code=401, detail="invalid or missing bearer token")

    class ScrapeBody(BaseModel):
        url: str
        timeout_ms: int | None = Field(default=None, ge=1000, le=120_000)
        # PAGE-ARCHIVE-PRD U1: capture MHTML + full-page screenshot on the
        # same render and return them inline. Only the archive pipeline's
        # capture fetch sets this.
        snapshot: bool = False

    class ParseBody(BaseModel):
        url: str

    def assert_http_url(url: str) -> None:
        scheme = urlparse(url).scheme
        if scheme not in ("http", "https"):
            raise HTTPException(status_code=422, detail=f"unsupported URL scheme: {scheme or '(none)'}")

    def trusted_workload_class(request: Request) -> str:
        value = request.headers.get("x-scoutpost-workload-class", "")
        if value not in _workload_classes:
            raise HTTPException(status_code=422, detail="invalid workload class")
        return value

    @app.get("/health")
    async def health(request: Request):
        return {"status": "ok", "browser": "warm" if request.app.state.scraper.warm else "cold"}

    @app.post("/scrape", dependencies=[Depends(require_token)])
    async def scrape(body: ScrapeBody, request: Request):
        assert_http_url(body.url)
        workload_class = trusted_workload_class(request)
        record_operation("snapshot" if body.snapshot else "scrape", workload_class)
        cfg: Settings = request.app.state.settings
        slots: asyncio.Semaphore = (
            request.app.state.snapshot_slot
            if body.snapshot
            else request.app.state.scrape_slots
        )
        try:
            await asyncio.wait_for(slots.acquire(), timeout=0.1)
        except asyncio.TimeoutError:
            raise HTTPException(
                status_code=503,
                detail="scrape capacity exhausted",
                headers={"Retry-After": "1"},
            )
        try:
            # SSRF guard (parity with /parse): a snapshot capture durably stores
            # fetched bytes behind a signed URL, so an internal target would
            # become a persistent exfiltration channel. DNS resolution is
            # synchronous, so keep it off the health endpoint's event loop.
            if cfg.block_private_addresses:
                try:
                    await asyncio.to_thread(assert_public_host, body.url)
                except PrivateAddressError:
                    raise HTTPException(
                        status_code=422,
                        detail={"error": "private_address"},
                    )
                except PdfDownloadError as e:
                    # Reused resolver raises this when the host will not resolve.
                    raise HTTPException(
                        status_code=422,
                        detail=f"cannot resolve host: {e}",
                    )
            timeout_ms = body.timeout_ms or cfg.default_scrape_timeout_ms
            try:
                mapped = await execute_crawl(
                    request.app.state.scraper,
                    body.url,
                    timeout_ms=timeout_ms,
                    snapshot=body.snapshot,
                )
                # The browser proxy blocks unsafe destinations before connect;
                # this final check also prevents an invalid effective URL from
                # reaching downstream extraction if a custom scraper is used.
                if cfg.block_private_addresses:
                    await asyncio.to_thread(assert_public_host, mapped["source_url"])
            except asyncio.TimeoutError:
                raise HTTPException(
                    status_code=504,
                    detail=f"scrape timed out after {timeout_ms}ms",
                )
            except CrawlResultError as e:
                raise HTTPException(status_code=502, detail=f"scrape failed: {e}")
            except PrivateAddressError:
                raise HTTPException(
                    status_code=422,
                    detail={"error": "private_address"},
                )
            except PdfDownloadError as e:
                raise HTTPException(
                    status_code=422,
                    detail=f"cannot resolve host: {e}",
                )
            except ValueError as e:
                raise HTTPException(
                    status_code=502, detail=f"crawl result mapping failed: {e}"
                )
            except Exception as e:  # crawl4ai raises library-specific errors
                raise HTTPException(status_code=502, detail=f"scrape failed: {e}")
        finally:
            slots.release()
        return mapped

    @app.post("/parse", dependencies=[Depends(require_token)])
    async def parse(body: ParseBody, request: Request):
        assert_http_url(body.url)
        record_operation("parse_pdf", trusted_workload_class(request))
        cfg: Settings = request.app.state.settings

        # parse_pdf_url always tries pdftotext first. Only a low-yield result
        # falls back to Google Vertex native-PDF transcription through
        # OpenRouter. Absent key → the density guard returns needs_ocr.
        transcribe = None
        if cfg.openrouter_api_key:
            async def transcribe(pdf_bytes: bytes) -> str:
                return await transcribe_pdf(
                    request.app.state.http_client,
                    pdf_bytes,
                    api_key=cfg.openrouter_api_key,
                    model=cfg.openrouter_model,
                    timeout_s=cfg.openrouter_timeout_s,
                )

        try:
            parsed = await parse_pdf_url(
                request.app.state.http_client,
                body.url,
                timeout_s=cfg.parse_download_timeout_s,
                max_bytes=cfg.parse_max_pdf_bytes,
                min_chars_per_page=cfg.parse_min_chars_per_page,
                transcribe=transcribe,
                transcribe_max_bytes=OPENROUTER_INLINE_MAX_BYTES,
            )
        except NeedsOcrError as e:
            raise HTTPException(
                status_code=422,
                detail={"error": "needs_ocr", "pages": e.pages, "chars": e.chars},
            )
        except PdfTooLargeError:
            raise HTTPException(status_code=413, detail={"error": "pdf_too_large"})
        except NotAPdfError:
            raise HTTPException(status_code=415, detail={"error": "not_a_pdf"})
        except PrivateAddressError:
            raise HTTPException(status_code=422, detail={"error": "private_address"})
        except PdfTimeoutError as e:
            raise HTTPException(status_code=504, detail=e.detail)
        except OpenRouterParseError as e:
            # Fallback transcription itself failed → treat as an upstream 502.
            raise HTTPException(status_code=502, detail=e.detail)
        except PdfDownloadError as e:
            raise HTTPException(status_code=502, detail=e.detail)
        return {
            "markdown": parsed.text,
            "pages": parsed.pages,
            "chars": parsed.chars,
            "parser": parsed.parser,
            "source_url": body.url,
        }

    return app

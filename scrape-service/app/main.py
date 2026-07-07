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
import secrets as secrets_mod
from contextlib import asynccontextmanager
from urllib.parse import urlparse

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field

from .config import Settings, load_settings
from .gemini_pdf import GEMINI_INLINE_MAX_BYTES, GeminiParseError, transcribe_pdf
from .mapping import crawl_failure_detail, map_crawl_result
from .pdfparse import (
    NeedsOcrError,
    NotAPdfError,
    PdfDownloadError,
    PdfTimeoutError,
    PdfTooLargeError,
    PrivateAddressError,
    parse_pdf_url,
)
from .scraper import Scraper
from .snapshots import build_snapshot_payload, scrape_fuse_seconds

_bearer = HTTPBearer(auto_error=False)


def create_app(settings: Settings | None = None) -> FastAPI:
    resolved = settings if settings is not None else load_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        yield
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

    @app.get("/health")
    async def health(request: Request):
        return {"status": "ok", "browser": "warm" if request.app.state.scraper.warm else "cold"}

    @app.post("/scrape", dependencies=[Depends(require_token)])
    async def scrape(body: ScrapeBody, request: Request):
        assert_http_url(body.url)
        cfg: Settings = request.app.state.settings
        timeout_ms = body.timeout_ms or cfg.default_scrape_timeout_ms
        try:
            result = await asyncio.wait_for(
                request.app.state.scraper.run(
                    body.url, timeout_ms=timeout_ms, snapshot=body.snapshot,
                ),
                # Snapshot fetches budget for crawl4ai's separately-timed
                # capture phases (scan wait_for + MHTML readiness waits +
                # screenshot compositor) — see scrape_fuse_seconds.
                timeout=scrape_fuse_seconds(timeout_ms, body.snapshot),
            )
        except asyncio.TimeoutError:
            raise HTTPException(status_code=504, detail=f"scrape timed out after {timeout_ms}ms")
        except Exception as e:  # crawl4ai raises library-specific errors
            raise HTTPException(status_code=502, detail=f"scrape failed: {e}")
        if not getattr(result, "success", False):
            raise HTTPException(status_code=502, detail=f"scrape failed: {crawl_failure_detail(result)}")
        try:
            mapped = map_crawl_result(result, requested_url=body.url)
        except ValueError as e:
            raise HTTPException(status_code=502, detail=f"crawl result mapping failed: {e}")
        if body.snapshot:
            # Capture problems never fail the scrape: the caller still needs
            # the markdown for change detection, and degrades the archive
            # record per KTD9 when snapshot_error is set. Payload assembly is
            # pure CPU over multi-MB buffers → off the event loop; and NO
            # exception may escape past the markdown.
            try:
                payload, snapshot_error = await asyncio.to_thread(
                    build_snapshot_payload, result,
                )
            except Exception as e:
                payload, snapshot_error = None, (
                    f"payload_assembly_failed:{e.__class__.__name__}"
                )
            if payload is not None:
                mapped["snapshot"] = payload
            else:
                mapped["snapshot_error"] = snapshot_error
        return mapped

    @app.post("/parse", dependencies=[Depends(require_token)])
    async def parse(body: ParseBody, request: Request):
        assert_http_url(body.url)
        cfg: Settings = request.app.state.settings

        # Low-yield (scanned / thin) PDFs fall back to Gemini native-PDF
        # transcription when a key is configured (U3d). Absent key → the
        # density guard 422s as before.
        transcribe = None
        if cfg.gemini_api_key:
            async def transcribe(pdf_bytes: bytes) -> str:
                return await transcribe_pdf(
                    request.app.state.http_client,
                    pdf_bytes,
                    api_key=cfg.gemini_api_key,
                    model=cfg.gemini_model,
                    timeout_s=cfg.gemini_timeout_s,
                )

        try:
            parsed = await parse_pdf_url(
                request.app.state.http_client,
                body.url,
                timeout_s=cfg.parse_download_timeout_s,
                max_bytes=cfg.parse_max_pdf_bytes,
                min_chars_per_page=cfg.parse_min_chars_per_page,
                transcribe=transcribe,
                transcribe_max_bytes=GEMINI_INLINE_MAX_BYTES,
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
        except GeminiParseError as e:
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

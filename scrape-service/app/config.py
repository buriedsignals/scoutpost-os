"""Environment configuration for the scrape-service.

Fail-closed on auth: the service renders arbitrary URLs on request, so it must
never boot as an open proxy. SCRAPE_SERVICE_TOKEN is mandatory unless the
operator explicitly opts into anonymous mode for a local playground.
"""

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    token: str | None
    allow_anon: bool
    browser_pool_size: int
    default_scrape_timeout_ms: int
    parse_download_timeout_s: float
    parse_max_pdf_bytes: int
    parse_min_chars_per_page: int
    # Gemini native-PDF fallback for low-yield (scanned / thin) PDFs. When the
    # density guard trips and a key is present, /parse transcribes via Gemini
    # instead of returning needs_ocr. Absent key → density guard still 422s.
    gemini_api_key: str | None
    gemini_model: str
    gemini_timeout_s: float


def load_settings(env: dict[str, str] | None = None) -> Settings:
    e = os.environ if env is None else env
    token = e.get("SCRAPE_SERVICE_TOKEN") or None
    allow_anon = e.get("SCRAPE_SERVICE_DEV_NO_AUTH") == "1"
    if token is None and not allow_anon:
        raise RuntimeError(
            "SCRAPE_SERVICE_TOKEN is not set. Refusing to start as an open proxy. "
            "Set the token, or SCRAPE_SERVICE_DEV_NO_AUTH=1 for a local playground only."
        )
    return Settings(
        token=token,
        allow_anon=allow_anon,
        browser_pool_size=int(e.get("SCRAPE_BROWSER_POOL_SIZE", "2")),
        default_scrape_timeout_ms=int(e.get("SCRAPE_DEFAULT_TIMEOUT_MS", "25000")),
        parse_download_timeout_s=float(e.get("PARSE_DOWNLOAD_TIMEOUT_S", "15")),
        parse_max_pdf_bytes=int(e.get("PARSE_MAX_PDF_BYTES", str(50 * 1024 * 1024))),
        parse_min_chars_per_page=int(e.get("PARSE_MIN_CHARS_PER_PAGE", "100")),
        gemini_api_key=e.get("GEMINI_API_KEY") or None,
        gemini_model=e.get("PARSE_GEMINI_MODEL", "gemini-2.5-flash-lite"),
        gemini_timeout_s=float(e.get("PARSE_GEMINI_TIMEOUT_S", "90")),
    )

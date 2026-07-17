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
    # OpenRouter/Google Vertex native-PDF fallback for low-yield PDFs. When the
    # density guard trips and a key is present, /parse transcribes through the
    # pinned ZDR route. Absent key → density guard still returns needs_ocr.
    openrouter_api_key: str | None
    openrouter_model: str
    openrouter_timeout_s: float
    # SSRF guard: reject /scrape targets whose host resolves to a
    # loopback/private/link-local/metadata address. On by default (hosted SaaS
    # only ever scrapes public URLs, and snapshot capture now durably STORES the
    # fetched bytes behind a signed URL — an internal-network response would be
    # an exfiltration channel). Self-hosters legitimately monitoring internal
    # hosts can opt out with SCRAPE_ALLOW_PRIVATE_ADDRESSES=1.
    block_private_addresses: bool


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
        openrouter_api_key=e.get("OPENROUTER_API_KEY") or None,
        openrouter_model=e.get(
            "PARSE_OPENROUTER_MODEL", "google/gemini-2.5-flash-lite"
        ),
        openrouter_timeout_s=float(e.get("PARSE_OPENROUTER_TIMEOUT_S", "90")),
        block_private_addresses=e.get("SCRAPE_ALLOW_PRIVATE_ADDRESSES") != "1",
    )

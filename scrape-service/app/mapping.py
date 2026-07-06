"""KTD2: map Crawl4AI's CrawlResult to the ScrapeResult shape the edge
functions consume (see supabase/functions/_shared/firecrawl.ts:18-27).

The mapping lives server-side so the Deno adapter stays a thin authenticated
HTTP client and this contract is versioned in-repo — upstream Crawl4AI API
drift surfaces here, in this service's own test suite, never in the adapters.

Field mapping (SCRAPING-MIGRATION-PRD KTD2):
  markdown.raw_markdown -> markdown   (never fit_markdown: main-content
                                       filtering is what destroyed the Zermatt
                                       page under Firecrawl's onlyMainContent)
  html                  -> rawHtml    (raw page HTML — civic link extraction)
  cleaned_html          -> html
  metadata.title        -> title
  metadata              -> metadata   (keeps sourceURL-equivalent keys so the
                                       publication-date fallback in
                                       atomic_extract.ts keeps working)
  status_code           -> status_code (drives 4xx/"removed" semantics upstream)
"""

from datetime import datetime, timezone
from typing import Any


def _extract_markdown(raw: Any) -> str:
    # Crawl4AI's markdown field is a MarkdownGenerationResult (raw_markdown /
    # fit_markdown attributes), a plain string on some paths, or absent.
    # Any other shape means upstream API drift — fail LOUD (the caller maps it
    # to a 502) rather than shipping repr() garbage into content-hash-keyed
    # dedup; surfacing drift at this seam is the point of the KTD2 mapping.
    if raw is None:
        return ""
    if isinstance(raw, str):
        return raw
    raw_markdown = getattr(raw, "raw_markdown", None)
    if isinstance(raw_markdown, str):
        return raw_markdown
    raise ValueError(f"unexpected crawl markdown shape: {type(raw).__name__}")


def map_crawl_result(result: Any, requested_url: str) -> dict[str, Any]:
    metadata = getattr(result, "metadata", None) or {}
    title = metadata.get("title") if isinstance(metadata, dict) else None
    source_url = getattr(result, "url", None) or requested_url
    return {
        "markdown": _extract_markdown(getattr(result, "markdown", None)),
        "rawHtml": getattr(result, "html", None),
        "html": getattr(result, "cleaned_html", None),
        "title": title,
        "metadata": metadata if isinstance(metadata, dict) else {},
        "requested_url": requested_url,
        "source_url": source_url,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "status_code": getattr(result, "status_code", None),
    }


def crawl_failure_detail(result: Any) -> str:
    message = getattr(result, "error_message", None)
    status = getattr(result, "status_code", None)
    parts = [p for p in (f"status {status}" if status else None, message) if p]
    return "; ".join(parts) or "crawl failed without detail"

# scrape-service

Self-hosted replacement for Firecrawl scrape + PDF parse
(`SCRAPING-MIGRATION-PRD.md`). One container: FastAPI + the Crawl4AI library
(Playwright render) + poppler `pdftotext`.

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /scrape` `{url, timeout_ms?}` | Bearer | Playwright render → `ScrapeResult` JSON (KTD2 mapping, server-side) |
| `POST /parse` `{url}` | Bearer | PDF → deterministic text via `pdftotext -layout` (`parser:"pdftotext"`). Low-yield/scanned docs fall back to Gemini native-PDF transcription when `GEMINI_API_KEY` is set (`parser:"gemini"`), else `422 {error:"needs_ocr"}` |
| `GET /health` | none | `{status, browser: warm\|cold}` — Render health checks cannot send headers |

Error taxonomy (mirrors `_shared/scrape.ts`): upstream failure → 502,
timeout → 504, scanned PDF → 422, oversized → 413, non-PDF → 415, bad token → 401.

## Env

- `SCRAPE_SERVICE_TOKEN` — **required** (fail-closed; the service renders
  arbitrary URLs and must never run as an open proxy). Local playground only:
  `SCRAPE_SERVICE_DEV_NO_AUTH=1`.
- `SCRAPE_BROWSER_POOL_SIZE` (2) · `SCRAPE_DEFAULT_TIMEOUT_MS` (25000) ·
  `PARSE_DOWNLOAD_TIMEOUT_S` (15) · `PARSE_MAX_PDF_BYTES` (50MiB) ·
  `PARSE_MIN_CHARS_PER_PAGE` (100) · `PORT` (8080)
- `GEMINI_API_KEY` (optional) enables the low-yield PDF fallback ·
  `PARSE_GEMINI_MODEL` (`gemini-2.5-flash-lite`) · `PARSE_GEMINI_TIMEOUT_S` (90).
  Scope: catches scanned/thin PDFs the density guard flags. It does NOT
  auto-detect font-encoding degradation on text-rich PDFs (e.g. a report where
  pdftotext extracts plenty but mangles some words) — those stay on pdftotext.

## Develop

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest            # unit tier: 100% coverage gate, no browser
# live browser tier (needs: pip install -r requirements.txt && crawl4ai-setup):
.venv/bin/python -m pytest -m live --no-cov
```

Local container: `scripts/dev/scrape-stack.sh` from the repo root.

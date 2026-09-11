# scrape-service

Self-hosted replacement for Firecrawl scrape + PDF parse
(`SCRAPING-MIGRATION-PRD.md`). One container: FastAPI + the Crawl4AI library
(Playwright render) + poppler `pdftotext`.

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /scrape` `{url, timeout_ms?}` | Bearer | Playwright render → `ScrapeResult` JSON (KTD2 mapping, server-side), including a quality-gated semantic-main comparison projection when available |
| `POST /parse` `{url}` | Bearer | PDF → deterministic text via `pdftotext -layout` (`parser:"pdftotext"`). Low-yield/scanned docs fall back to Google Vertex native-PDF transcription through OpenRouter when `OPENROUTER_API_KEY` is set (`parser:"openrouter"`), else `422 {error:"needs_ocr"}` |
| `GET /health` | none | `{status, browser: warm\|cold, pdf_ocr}` — Render health checks cannot send headers |

Error taxonomy (mirrors `_shared/scrape.ts`): upstream failure → 502,
timeout → 504, scanned PDF → 422, oversized → 413, non-PDF → 415, bad token → 401.

`markdown` always contains the complete renderer output. For substantial
`main`, `[role=main]`, or single/dominant `article` landmarks, the response also
sets `comparison_markdown`, `comparison_strategy`, and `comparison_ratio`.
Otherwise `comparison_markdown` is null and `comparison_strategy` is `full`.

## Env

- `SCRAPE_SERVICE_TOKEN` — **required** (fail-closed; the service renders
  arbitrary URLs and must never run as an open proxy). Local playground only:
  `SCRAPE_SERVICE_DEV_NO_AUTH=1`.
- `SCRAPE_BROWSER_POOL_SIZE` (2) · `SCRAPE_DEFAULT_TIMEOUT_MS` (25000) ·
  `PARSE_DOWNLOAD_TIMEOUT_S` (15) · `PARSE_MAX_PDF_BYTES` (50MiB) ·
  `PARSE_MIN_CHARS_PER_PAGE` (100) · `PORT` (8080)
- `OPENROUTER_API_KEY` (optional) enables the low-yield PDF fallback ·
  `PARSE_OPENROUTER_MODEL` (`google/gemini-2.5-flash-lite`) ·
  `PARSE_OPENROUTER_TIMEOUT_S` (90). Every fallback request pins
  `google-vertex`, requires ZDR, denies data collection, disables OpenRouter
  response caching, and forces the native PDF parser. PDFs over the temporary
  conservative 4 MiB inline cap return `needs_ocr` pending the live boundary
  probe; the service never switches to a non-native parser.
  Scope: catches scanned/thin PDFs the density guard flags. It does NOT
  auto-detect font-encoding degradation on text-rich PDFs (e.g. a report where
  pdftotext extracts plenty but mangles some words) — those stay on pdftotext.

## OCR deployment verification

The HTTP service and Render `crawl_batch` workflow load their own runtime
settings. Configure `OPENROUTER_API_KEY` on the workload that actually parses
PDFs; setting it only on FastAPI does not enable OCR in the workflow. Use the
managed secret configuration, never a committed value.

`GET /health` and the completed workflow report include `pdf_ocr`:
`configured` or `disabled_missing_api_key`. This is redacted configuration
presence, not proof of a working provider route. Optional OCR being disabled
does not fail health or block HTML/text-PDF processing. Verify the real route
with a bounded scanned-PDF canary and confirm `parser: "openrouter"` plus usable
text; a text-bearing PDF must continue to report `parser: "pdftotext"`.

Low-yield failures retain `needs_ocr` compatibility and add a reason:
`ocr_not_configured` (set the key on the parsing workload) or
`ocr_inline_limit_exceeded` (do not retry the same inline request). The workflow
classifies both as terminal. Provider/network failures retain the existing
bounded retry policy. Civic's separate extraction queue may still retry these
terminal parser outcomes up to its own cap; the reason is preserved in its
failure message, so those attempts must not be read as provider recovery.

## Develop

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest            # unit tier: 100% coverage gate, no browser
# live browser tier (needs: pip install -r requirements.txt && patchright install chromium):
.venv/bin/python -m pytest -m live --no-cov
```

Local container: `scripts/dev/scrape-stack.sh` from the repo root.

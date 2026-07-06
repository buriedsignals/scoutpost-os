# scrape-service — self-hosted scraping (Firecrawl replacement)

The `scrape-service/` container replaces Firecrawl for the whole platform
(SCRAPING-MIGRATION-PRD). It runs the **Crawl4AI** library (Playwright browser
rendering) for HTML → markdown and **poppler `pdftotext`** for PDF → text, with
an optional **Gemini native-PDF** fallback for scanned/thin documents. The
Supabase edge functions call it over HTTP through the scrape port
(`_shared/scrape.ts`, `_shared/docparse.ts`).

| Endpoint | Purpose |
|---|---|
| `POST /scrape` `{url, timeout_ms?}` | Browser render → `ScrapeResult` JSON |
| `POST /parse` `{url}` | PDF → text (`parser:"pdftotext"`), low-yield → Gemini (`parser:"gemini"`), else `422 needs_ocr` |
| `GET /health` | unauthenticated liveness (Render/compose health checks) |

All non-health endpoints require `Authorization: Bearer <SCRAPE_SERVICE_TOKEN>`.

## Production (Render) — one-time provisioning

The service is declared in root `render.yaml` as `scoutpost-scrape` (Standard
plan, Frankfurt, `dockerfilePath: ./scrape-service/Dockerfile`). To bring it up:

1. **Deploy** — merge the migration PR; Render creates the `scoutpost-scrape`
   service from the blueprint. First build installs Playwright/Chromium
   (several minutes).
2. **Token** — generate a strong token and set it on the Render service:
   `openssl rand -base64 32` → Render dashboard → `scoutpost-scrape` →
   Environment → `SCRAPE_SERVICE_TOKEN`.
3. **Gemini fallback (optional)** — set `GEMINI_API_KEY` on the service to
   enable scanned-PDF transcription; omit it to have scanned PDFs return
   `needs_ocr`.
4. **Wire the edge functions** — mirror the URL + token into Supabase function
   secrets (the functions read these, not Render):
   ```
   supabase secrets set \
     SCRAPE_SERVICE_URL=https://scoutpost-scrape.onrender.com \
     SCRAPE_SERVICE_TOKEN=<the token from step 2>
   ```
   Leave `SCRAPE_PROVIDER` unset (defaults to `firecrawl`) until the U7 cutover.
5. **Verify** — authenticated `POST /scrape` and `/parse` round-trips from
   outside the VPC; unauthenticated requests must return 401; `/docs` and
   `/openapi.json` must return 404 (disabled).

## Cutover (U7)

Flip production to the self-hosted service by setting the provider secret:
```
supabase secrets set SCRAPE_PROVIDER=crawl4ai
```
Rollback is the reverse (`SCRAPE_PROVIDER=firecrawl`) — keep it available for
the full bake window. `FIRECRAWL_API_KEY` must remain set until U8.

## OSS / self-host

`deploy/docker/docker-compose.yml` ships the `scrape-service` container
**default-on** with `SCRAPE_PROVIDER=crawl4ai` — self-hosters no longer need a
paid Firecrawl key. The edge-functions service points at
`http://scrape-service:8080` with a shared `SCRAPE_SERVICE_TOKEN`
(defaults to a local dev token).

## Maintenance

- **Version bumps (monthly):** `crawl4ai` and Playwright/Chromium are pinned in
  `scrape-service/requirements.txt` and `Dockerfile`. Bump, run
  `cd scrape-service && python -m pytest` (100% coverage gate), rebuild. Library
  API drift surfaces in that suite, never in the Deno adapters (the REST
  contract is ours, versioned in-repo).
- **Token rotation:** set a new `SCRAPE_SERVICE_TOKEN` on Render, then re-run
  the `supabase secrets set` for `SCRAPE_SERVICE_TOKEN`. Brief overlap causes no
  downtime (the service reads its token at request time).
- **Memory:** Standard plan is 2 GB; the service caps the Playwright pool at 2.
  Watch Render memory on scrape bursts; escape hatch is the Pro plan.
- **Alerting:** enable Render health-check + resource alerts on
  `scoutpost-scrape`; a scrape-service outage surfaces to scouts as provider
  errors (refunded automatically via the existing run-lifecycle machinery).

# Crawl4AI rendering service and Workflow adapter

The `scrape-service/` code is Scoutpost's primary page and document renderer.
It runs the **Crawl4AI** library (Playwright browser rendering) for
HTML → markdown and Poppler **`pdftotext -layout`** for
deterministic PDF → text, with an optional **Google native-PDF through
OpenRouter** fallback for scanned/thin documents. Supabase Edge Functions use
the same HTTP contract in both deployments:

| Deployment | `SCRAPE_SERVICE_URL` | Execution |
| --- | --- | --- |
| Hosted target | `https://<project-ref>.supabase.co/functions/v1/crawler-proxy` | Durable Supabase ledger → Render Workflow |
| Docker self-host | `http://scrape-service:8080` | Local container; no Render account or Workflow cost |

The shared callers are `_shared/scrape.ts` and `_shared/docparse.ts`.

| Endpoint | Purpose |
|---|---|
| `POST /scrape` `{url, timeout_ms?}` | Browser render → `ScrapeResult` JSON |
| `POST /parse` `{url}` | PDF → text (`parser:"pdftotext"`), low-yield → Google native PDF through OpenRouter (`parser:"openrouter"`), else `422 needs_ocr` |
| `GET /health` | unauthenticated liveness (Render/compose health checks) |

All non-health endpoints require `Authorization: Bearer <SCRAPE_SERVICE_TOKEN>`.

## Hosted production rollout

The `crawler-proxy` Edge Function preserves `/scrape` and `/parse`, admits each
call into `crawler_jobs`, nudges `crawler-dispatch`, verifies the private result
artifacts, and returns the existing response shape. Every immediate nudge names
the just-enqueued job and forms a one-job batch; scheduled recovery retains the
normal throughput-oriented batch sizes and shared 28-start reservation gate.
Successful proxy artifacts are removed on consumption, with a scheduled
30-minute orphan sweep; the same sweep closes proxy-only anti-bot handoffs
whose caller disconnected before delegating the existing Firecrawl fallback.
Callers must send a validated server-owned tenant key: the verified user UUID
for Scout/utility work, or `system:<consumer>` for true system work. Scout
traffic uses normal admission; utility and system traffic use the atomic
per-tenant and rolling 24-hour cost guard.

The proxy streams whitespace heartbeats. After the first byte, a failure must
use the private `_scoutpost_workflow_error` envelope under HTTP 200; the two
shared clients restore the logical legacy scrape/parse error behavior. The
response header `X-Scoutpost-Proxy-Request-Id` equals the ledger row's
`continuation_key` for operator correlation.

After the migration and direct scrape/PDF/snapshot canaries pass, route hosted
callers with one reversible secret change:

```
supabase secrets set \
  SCRAPE_SERVICE_URL=https://<project-ref>.supabase.co/functions/v1/crawler-proxy
```

Keep `SCRAPE_SERVICE_TOKEN` unchanged during cutover. After retirement, first
recreate and verify the hosted recovery service, then route back to it. See
[Crawler Workflow cutover](../operations/crawler-workflow-cutover.md).

## Retired hosted HTTP recovery service

The temporary `scoutpost-scrape` Standard web service was removed from the
production `render.yaml` after the Workflow retirement gate closed on
2026-08-17. Hosted callers use `crawler-proxy`; Docker self-hosting continues
to use the same HTTP adapter and image. A validated, recovery-only Blueprint is
retained at
[`scoutpost-scrape-recovery.render.yaml`](../operations/scoutpost-scrape-recovery.render.yaml).
To recreate the hosted rollback target:

1. **Deploy** — restore the service entry from the recovery Blueprint to root
   `render.yaml` in a reviewed change, validate both files, and merge it.
   Render creates `scoutpost-scrape`; the first build installs
   Playwright/Chromium and takes several minutes.
2. **Token** — generate a strong token and set it on the Render service:
   `openssl rand -base64 32` → Render dashboard → `scoutpost-scrape` →
   Environment → `SCRAPE_SERVICE_TOKEN`.
3. **Native-PDF fallback (optional)** — set `OPENROUTER_API_KEY` on the
   service to enable scanned-PDF transcription with
   `google/gemini-2.5-flash-lite` through Google Vertex; omit it to have
   scanned PDFs return `needs_ocr`. The request forces OpenRouter's `native`
   PDF engine, so it does not invoke Mistral, Cloudflare, or another parser.
4. **Wire the edge functions for rollback** — mirror the URL + token into
   Supabase function secrets (the functions read these, not Render):
   ```
   supabase secrets set \
     SCRAPE_SERVICE_URL=https://scoutpost-scrape.onrender.com \
     SCRAPE_SERVICE_TOKEN=<the token from step 2>
   ```
   Leave `SCRAPE_PROVIDER` unset to use the `crawl4ai` default. Set it to
   `firecrawl` only for deliberate compatibility rollback.
5. **Verify** — authenticated `POST /scrape` and `/parse` round-trips from
   outside the VPC; unauthenticated requests must return 401; `/docs` and
   `/openapi.json` must return 404 (disabled).

The PDF fallback follows the same AI policy as the rest of Scoutpost:
`only: ["google-vertex"]`, ZDR required, provider data collection denied, and
`X-OpenRouter-Cache: false`. If that constrained route or the proven inline
PDF boundary is unavailable, the service returns `needs_ocr`; it does not
silently change providers or parsers. OpenRouter remains a processor between
Scoutpost and Google Vertex.

See OpenRouter's official [PDF input](https://openrouter.ai/docs/guides/overview/multimodal/pdfs)
and [provider-routing](https://openrouter.ai/docs/guides/routing/provider-selection)
documentation for the wire contract and parser selection behavior.

## Provider selection

The Crawl4AI port is the default. Production may set the provider secret
explicitly for clarity:
```
supabase secrets set SCRAPE_PROVIDER=crawl4ai
```
Compatibility rollback is the reverse (`SCRAPE_PROVIDER=firecrawl`).
`FIRECRAWL_API_KEY` remains required for Beat search and for the classified
anti-bot scrape fallback.

## OSS / self-host

`deploy/docker/docker-compose.yml` ships the `scrape-service` container
**default-on** with `SCRAPE_PROVIDER=crawl4ai`. Self-hosters still need a
Firecrawl Cloud key for Beat search and the classified anti-bot fallback. The
edge-functions service points at
`http://scrape-service:8080` with a shared `SCRAPE_SERVICE_TOKEN`
(defaults to a local dev token).

## Maintenance

- **Version bumps (monthly):** `crawl4ai` is exact-pinned in
  `scrape-service/requirements.txt`; the clean Docker build resolves Patchright
  and installs its matching Chromium revision. Inspect the candidate source at
  every API used by `app/scraper.py`, run `cd scrape-service && python -m pytest`
  (100% coverage gate), rebuild without cached browser layers, and run the live
  browser plus HTTP/Workflow contract probes. Library API drift is absorbed by
  the service mapping and never leaked into the Deno adapters (the REST contract
  is ours, versioned in-repo). The current 0.9.2 validation record is
  [`crawl4ai-0.9.2-validation.md`](crawl4ai-0.9.2-validation.md).
- **Token rotation:** set a new `SCRAPE_SERVICE_TOKEN` on Render, then re-run
  the `supabase secrets set` for `SCRAPE_SERVICE_TOKEN`. Brief overlap causes no
  downtime (the service reads its token at request time).
- **Hosted rollback service:** if temporarily recreated, keep its health and
  resource alerts active. The Standard plan is 2 GB and caps the Playwright
  pool at 2; retire it again after the incident and a fresh observation gate.
- **Workflow runtime:** monitor queue age, task duration, retries, terminal
  failures, and transient Storage artifacts through the existing crawler
  ledger and operations health checks.

## Snapshot capture (PAGE-ARCHIVE-PRD U1)

`POST /scrape` accepts `snapshot: true` (set only by the Page Archive capture
fetch). The same `arun` that produces the markdown also captures MHTML
(`capture_mhtml`) and a full-page screenshot (`screenshot`) — same-render
provenance is the contract (KTD1/KTD2). Artifacts return **inline** as
base64 with SHA-256 hashes computed over the exact bytes
(`snapshot.{mhtml_b64,mhtml_sha256,screenshot_b64,screenshot_sha256,sizes}`);
screenshots ship as rendered (PNG) whenever they fit the caps; see the
re-encoding rule below for over-budget captures (Decision 9, as amended
2026-09-03). The service keeps **zero snapshot state** — no tmp files, no pickup endpoint —
so horizontal scaling stays safe.

Every browser scrape runs a disclosure pass, capped at 32 total interactions,
immediately before extraction. It opens native `details` elements on any host.
Only requests classified as `tiktok.com` and still on `tiktok.com` after
redirects get the additional `marcom-web-collapse-panel` click pass, and that
pass rejects form-associated buttons, generic buttons, and `aria-expanded`
controls. Ordinary change-detection scrapes and snapshot scrapes therefore
see the same interaction-mounted disclosure text. This is separate from
`scan_full_page`, which is snapshot-only and loads content triggered by
scrolling rather than clicking.

Caps (R8): 25 MB per artifact, 30 MB combined, with cheap pre-materialization
guards. Over-cap, incomplete, or non-genuine captures never fail the scrape:
the response carries a structured `snapshot_error` instead of a payload and
the archive pipeline degrades to a `markdown_only` record. `response_headers`
is mapped on every scrape response for the snapshot record's capture metadata.

**Over-budget screenshots are re-encoded, not dropped** (2026-09-03). A
full-page capture of a very long article (Grokipedia's Bitcoin page renders
at 1065 x 52845 px) leaves crawl4ai as a ~42 MB RGB PNG. Before declaring it
`artifact_too_large`, `snapshots.py` re-encodes it with Pillow as a
256-colour palette PNG at full resolution (15.7 MB for that page), and only
if that still exceeds the budget downscales to 0.75x, then 0.5x. The budget
is the per-artifact cap or whatever the combined cap leaves after the
MHTML, whichever is smaller. The payload discloses any re-encoding as
`snapshot.screenshot_encoding = {palette_colors, scale, original_bytes,
original_size}`; the hash still covers exactly the stored bytes. Base64
screenshots estimated above 4x the artifact cap are rejected without
decoding, and Pillow's decompression-bomb guard is kept at 200 MP.

Integrity and fidelity notes (U1 review findings, all confirmed):

- crawl4ai screenshots **never fail loudly** — capture errors return a black
  JPEG error card. The payload requires PNG magic bytes and rejects anything
  else (`snapshot_error: screenshot_not_png:*`), so a fake artifact is never
  sealed as evidence.
- For scrollable pages crawl4ai's full-page compositor stitches **JPEG-q85
  segments** into the final PNG (Decision 10b disclosure): the hash covers
  exactly the stored bytes, but the pixels are not lossless; MHTML is the
  primary fidelity artifact.
- The capture fetch's markdown can include additional scroll-triggered content
  because `scan_full_page` scrolls before HTML retrieval. That snapshot-only
  content **must not feed change detection** — it is the snapshot's `.md`
  record only (Decision 10a). Disclosure content is different: the bounded
  disclosure pass runs in both scrape modes and intentionally feeds change
  detection.
- Snapshot scrapes get a larger outer fuse (`scrape_fuse_seconds`: 2x
  timeout + 20 s) because crawl4ai times the scan/capture phases separately
  from `page_timeout`; and they serialize on a dedicated single-slot
  semaphore so long captures cannot starve ordinary scrapes out of the
  browser pool.

Renderer corrections can produce a one-time content uplift for existing
scouts whose baselines omitted interaction-mounted text. Treat that first
known transition as an extraction correction, not evidence of a publisher
policy change, and deliberately establish a corrected baseline where needed.
Scoutpost does not rewrite or silently recapture historical baselines.

Verification: `pytest -m live --no-cov` includes a snapshot capture probe
that must pass under the production browser config (UndetectedAdapter +
stealth + headed/xvfb in the container), and `scripts/dev/scrape-stack.sh`
plus a `snapshot: true` curl against a heavy page is the container-level
smoke.

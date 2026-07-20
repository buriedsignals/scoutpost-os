<div align="center">

# Scoutpost

### Open-source monitoring for investigative and local journalism

**AI scouts that watch public pages, news coverage, social profiles, civic records, and transport activity on a schedule. They turn what they find into source-linked, deduplicated information units for journalists and AI assistants — with human verification and optional tamper-evident evidence snapshots. Self-host it, or sign in at scoutpost.ai.**

[Quick Start](#quick-start) | [Deployment](#deployment) | [Docs](#documentation) | [FAQ](https://www.scoutpost.ai/faq) | [scoutpost.ai](https://www.scoutpost.ai/)

[![License: Sustainable Use](https://img.shields.io/badge/license-Sustainable_Use-ff6d00?style=for-the-badge&logo=opensourceinitiative&logoColor=white)](LICENSE.md)[![5 Scout Types](https://img.shields.io/badge/scout_types-5-aa00ff?style=for-the-badge&logo=windowsterminal&logoColor=white)](#overview)[![12 Languages](https://img.shields.io/badge/languages-12-0080ff?style=for-the-badge&logo=googletranslate&logoColor=white)](https://www.scoutpost.ai/)[![CLI on npm](https://img.shields.io/npm/v/scoutpost-cli?style=for-the-badge&logo=npm&logoColor=white&label=scout%20CLI&color=00bfa5)](https://www.npmjs.com/package/scoutpost-cli)

[![Stars](https://img.shields.io/github/stars/buriedsignals/scoutpost-os?style=flat-square&logo=github&label=Stars)](https://github.com/buriedsignals/scoutpost-os/stargazers)[![Issues](https://img.shields.io/github/issues/buriedsignals/scoutpost-os?style=flat-square&logo=github&label=Issues)](https://github.com/buriedsignals/scoutpost-os/issues)[![Last Commit](https://img.shields.io/github/last-commit/buriedsignals/scoutpost-os?style=flat-square&logo=github&label=Last%20Commit)](https://github.com/buriedsignals/scoutpost-os/commits)[![Contributors](https://img.shields.io/github/contributors/buriedsignals/scoutpost-os?style=flat-square&logo=github&label=Contributors)](https://github.com/buriedsignals/scoutpost-os/graphs/contributors)

Built by [**Buried Signals**](https://buriedsignals.com/) • Supported by [IMJ](https://www.imj.ch/) • [tom@buriedsignals.com](mailto:tom@buriedsignals.com)

</div>

---

## Overview

Scoutpost is monitoring infrastructure for investigative and local journalism.
Journalists define recurring scouts; each run finds source-linked information
units, deduplicates repeated coverage, and sends new leads to an editorial
inbox. The same workflow is available to people in the web app and to agents
through MCP, REST, or the `scout` CLI.

- **Page Scouts** watch one public URL for meaningful changes.
- **Beat Scouts** follow a topic or geography across relevant coverage.
- **Social Scouts** track new and deleted posts from public profiles.
- **Civic Scouts** follow council pages, agendas, minutes, and PDFs.
- **Fleet Scouts** alert when watched vessels, aircraft, or satellites enter a
  defined area.

Scouts run on schedules and notify the journalist when their criteria are met.
Information units are leads until a human verifies them; agents can organize,
search, and draft from the material, but must preserve that editorial boundary.

Page Scouts can optionally capture **tamper-evident evidence snapshots** of each
change (MHTML + screenshot + RFC 3161 timestamp, with optional Internet Archive
submission). Archiving is toggled per scout (`archive_enabled`) and snapshots are
retrievable through the UI-less agent surfaces — the `scout snapshots` CLI, the
`list_snapshots` / `get_snapshot_url` MCP tools, and the `/snapshots` REST
endpoints. See [`docs/features/page-archive.md`](docs/features/page-archive.md).

## Tech Stack

- **Frontend**: SvelteKit + TailwindCSS (static SPA)
- **Backend**: FastAPI (Python) — auth broker, feedback, admin, public `/api/v1`
- **Scout runtime**: Supabase Edge Functions + pg_cron (post-2026-04-22 cutover)
- **Database**: Supabase Postgres with pgvector + HNSW for hybrid search
- **Auth**: MuckRock OAuth 2.0 (SaaS) / Supabase Auth (OSS / self-hosted)
- **AI**: Google Gemini models through OpenRouter's Google Vertex route + Firecrawl
- **Hosting**: Render (Docker) for the FastAPI service; Supabase for EFs + DB

## Quick Start

### Prerequisites
- Node.js 22 LTS
- Python 3.13+ (3.11 works locally but CI runs 3.13)
- Deno 2.x (for the `cli/` package)

### Local Development

```bash
# Frontend
cd frontend && nvm use && npm install
npm run dev                     # private repo default: local FastAPI auth broker + hosted account data on localhost
npm run dev:hosted-broker       # diagnostic: same frontend, but use the deployed broker path
npm run dev:supabase-local-demo # disposable local Supabase auth + local-only onboarding demo

# Backend
cd backend && python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload

# CLI (scout)
cd cli && deno task run --help
```

### Environment Variables

Copy `.env.example` to `.env` and fill in the values. See
`docs/architecture/api-surface.md` for the current set of
load-bearing variables.

Scoutpost uses one external AI credential: `OPENROUTER_API_KEY`. Structured
extraction uses `google/gemini-2.5-flash-lite`, and text embeddings use
`google/gemini-embedding-001` with `dimensions: 768`. Every request pins
`google-vertex`, requires ZDR, denies provider data collection, disables
fallbacks, and sends `X-OpenRouter-Cache: false`.

PDF parsing stays local-first: Poppler `pdftotext -layout` is the deterministic
primary parser. Only low-yield or scanned PDFs use Google's native PDF handling
through OpenRouter. That request forces the `native` PDF engine, so OpenRouter
does not invoke Mistral, Cloudflare, or another parser; when the constrained
route is unavailable the document returns `needs_ocr`.

## Deployment

The FastAPI service auto-deploys to Render on push to `main`.
Supabase Edge Functions deploy via `supabase functions deploy <name>`
(see `supabase/functions/CLAUDE.md`).

**Always go via PR** — never push to `main`. CI must show 4 green
checks (`build-frontend`, `test-frontend`, `test-backend`, `lint`)
before merge.

## Documentation

- [Newsroom Docker install](docs/oss/newsroom-docker-install.md)
- [API surface (post-cutover)](docs/architecture/api-surface.md)
- [FastAPI endpoints (legacy + auth + v1)](docs/architecture/fastapi-endpoints.md)
- [Supabase Edge Functions](docs/supabase/edge-functions.md)
- [Developer guide](docs/architecture/developer-guide.md)
- [`scout` CLI](cli/README.md)

## Project Structure

```
├── frontend/        # SvelteKit SPA
├── backend/         # FastAPI service (auth, feedback, admin, /api/v1)
├── supabase/        # Edge Functions + migrations + pg_cron
├── cli/             # `scout` Deno CLI — talks to FastAPI or EFs
├── docs/            # Architecture + features + supabase docs
├── scripts/         # OSS strip + EF bundler + helpers
└── Dockerfile       # Production build for the FastAPI service
```

## Acknowledgements

Scoutpost stands on open work and specialist data services that do the heavy
operational lifting. A sincere thank-you to every project and provider below.
*(Listing does not imply affiliation or endorsement.)*

| Category | Projects we're grateful to |
|----------|----------------------------|
| **Scraping & browser automation** | [Crawl4AI](https://github.com/unclecode/crawl4ai) (unclecode, Apache-2.0 — the primary scraper) · [Playwright](https://playwright.dev/) (browser automation under the scraper) · [Poppler](https://poppler.freedesktop.org/) (`pdftotext` — civic-PDF extraction) |
| **Application runtime** | [Deno](https://deno.com/) (MIT — the `scout` CLI, MCP bridge, and every Edge Function) · [FastAPI](https://fastapi.tiangolo.com/) (Sebastián Ramírez, MIT — the backend API) |
| **Search & analysis** | [pgvector](https://github.com/pgvector/pgvector) (Andrew Kane — vector search behind semantic scout matching) · [langdetect](https://github.com/Mimino666/langdetect) (language detection in dedup scoring) |
| **Evidence archiving** | [Internet Archive / Wayback Machine](https://web.archive.org/) (optional evidence-snapshot submission) |
| **Fleet & transport data** | [adsb.lol](https://adsb.lol/) (community ADS-B network — live aircraft positions) · [VesselAPI](https://vesselapi.com/) (paid exact-MMSI vessel positions) · [CelesTrak](https://celestrak.org/) (T.S. Kelso — satellite orbital elements) · [satellite.js](https://github.com/shashwatak/satellite-js) (shashwatak, MIT — orbital math) |

These and the app's full credits also live at
[scoutpost.ai/acknowledgements](https://www.scoutpost.ai/acknowledgements).

> Built something here we should credit, or want a listing changed or removed?
> Open an issue or PR — we'll fix it fast.

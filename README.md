# coJournalist

AI-powered local news monitoring platform.

## Overview

coJournalist lets users create "scouts" that monitor:
- **Web pages** for content changes
- **Local news** for daily digests
- **Search queries** for specific topics
- **Social media profiles** for new posts and deletions
- **Data APIs** for threshold alerts

Scouts run on schedules and send email notifications when criteria are met.

## Tech Stack

- **Frontend**: SvelteKit + TailwindCSS (static SPA)
- **Backend**: FastAPI (Python) — auth broker, feedback, admin, public `/api/v1`
- **Scout runtime**: Supabase Edge Functions + pg_cron (post-2026-04-22 cutover)
- **Database**: Supabase Postgres with pgvector + HNSW for hybrid search
- **Auth**: MuckRock OAuth 2.0 (SaaS) / Supabase Auth (OSS / self-hosted)
- **AI**: Gemini 2.5 Flash-Lite (default) + OpenRouter (fallback) + Firecrawl
- **Hosting**: Render (Docker) for the FastAPI service; Supabase for EFs + DB

> Pre-cutover (now historical): scout scheduling lived on AWS Lambda +
> EventBridge with DynamoDB. The infra is being torn down — see
> `CUTOVER-DAY-1-VERIFICATION.md` for the punch list.

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

# CLI (cojo)
cd cli && deno task run -- --help
```

### Environment Variables

Copy `.env.example` to `.env` and fill in the values. See
`docs/architecture/api-surface-audit.md` for the current set of
load-bearing variables.

## Deployment

The FastAPI service auto-deploys to Render on push to `main`.
Supabase Edge Functions deploy via `supabase functions deploy <name>`
(see `supabase/functions/CLAUDE.md`).

**Always go via PR** — never push to `main`. CI must show 4 green
checks (`build-frontend`, `test-frontend`, `test-backend`, `lint`)
before merge.

## Documentation

- [Newsroom Docker install](docs/oss/newsroom-docker-install.md)
- [API surface audit (post-cutover)](docs/architecture/api-surface-audit.md)
- [FastAPI endpoints (legacy + auth + v1)](docs/architecture/fastapi-endpoints.md)
- [Supabase Edge Functions](docs/supabase/edge-functions.md)
- [Developer guide](docs/architecture/developer-guide.md)
- [`cojo` CLI](cli/README.md)

## Project Structure

```
├── frontend/        # SvelteKit SPA
├── backend/         # FastAPI service (auth, feedback, admin, /api/v1)
├── supabase/        # Edge Functions + migrations + pg_cron
├── cli/             # `cojo` Deno CLI — talks to FastAPI or EFs
├── docs/            # Architecture + features + supabase docs
├── scripts/         # OSS strip + EF bundler + helpers
└── Dockerfile       # Production build for the FastAPI service
```

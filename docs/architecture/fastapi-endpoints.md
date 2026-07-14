# FastAPI Endpoints Specification

> Last Updated: 2026-04-22 (post-cutover — see [api-surface.md](api-surface.md))
> Production URL: `https://scoutpost.ai` (FastAPI on Render, SPA served from same domain)

## Overview

FastAPI now hosts a thin set of endpoints: the auth broker (MuckRock OAuth + Supabase magiclink handoff), feedback (Linear), admin/billing (SaaS-only), the public `/api/v1` API, and a few legacy helpers (`/api/units/*`, `/api/export/*`, `/api/onboarding/*`, `/api/user/*`).

**All scout scheduling, execution, and data persistence moved to Supabase Edge Functions in the 2026-04-22 cutover.** The dead routers — `scouts.py`, `pulse.py`, `social.py`, `civic.py`, `scraper.py`, `data_extractor.py` — were deleted; the frontend api-client routes to EFs when `PUBLIC_DEPLOYMENT_TARGET=supabase`. Sections below that reference Lambda or AWS API Gateway describe the historical pre-cutover behavior; production no longer uses them and they're slated for removal once the AWS infra teardown completes.

---

## Authentication

### User Endpoints
Protected by Supabase Bearer JWTs in the current post-cutover runtime.
The `get_current_user()` dependency in `dependencies/auth.py` delegates to `providers.get_auth()`, which returns `SupabaseAuth` while `deployment_target == "supabase"`. The older session-cookie branch remains as residual fallback code only.

### Internal Edge Function / Worker Endpoints
Protected by the internal service-key boundary. In the current Supabase runtime,
the key is stored as a Supabase Edge Function secret / Supabase Vault value or
in local env files for self-hosted development.

```python
def verify_service_key(x_service_key: str) -> None:
    if x_service_key != settings.internal_service_key:
        raise HTTPException(status_code=401, detail="Invalid service key")
```

---

## Historical Scout Endpoint Sections

The sections below that describe `/api/scouts/execute`, `/api/pulse/execute`,
`/api/social/execute`, `/api/civic/execute`, `/api/scrapers/monitoring`, AWS
API Gateway, Lambda, EventBridge, DynamoDB records, or `SCRAPER#`/`TIME#`
records are retained only for migration/debugging context. Current scout
creation, scheduling, execution, and persistence use Supabase Edge Functions.

Current references:

- `docs/supabase/edge-functions.md`
- `docs/supabase/scouts-runs.md`
- `docs/supabase/social-apify.md`
- `docs/supabase/civic-pipeline.md`
- `docs/supabase/benchmarks.md`

---

## Page Archive Snapshot Endpoints

Edge-Function-served (proxied like the other Supabase Edge Functions when
`PUBLIC_DEPLOYMENT_TARGET=supabase`) by the `snapshots` Edge Function. Retrieve a
Page Scout's evidence snapshots and mint short-lived signed artifact download
URLs.

| Method | Path | Auth | Rate Limit | Description |
|--------|------|------|------------|-------------|
| GET | `/snapshots?scout_id=<id>` | User JWT or `cj_` API key | — | List a scout's evidence snapshots (paginated) |
| POST | `/snapshots/:id/url` | User JWT or `cj_` API key | — | Body `{ "artifact": "..." }` → 5-minute signed download URL. Artifact kinds: `mhtml \| screenshot \| rawhtml \| markdown \| manifest \| tsr` |

See `docs/features/page-archive.md` for the retrieval + toggle contract and
`docs/supabase/edge-functions.md` for the backing `snapshots` Edge Function.

---

## Auth Endpoints

### Hosted Production (MuckRock OAuth proxy)

**Location:** `backend/app/routers/muckrock_proxy.py`

| Method | Path | Auth | Rate Limit | Description |
|--------|------|------|------------|-------------|
| GET | `/api/auth/callback` | None | — | 302 proxy to hosted `auth-muckrock` Edge Function |
| POST | `/api/auth/webhook` | HMAC-SHA256 | — | Forward MuckRock webhook to hosted `billing-webhook` Edge Function |

The browser-facing login flow in production now starts at the hosted
`auth-muckrock` Edge Function, not FastAPI.

### Local Dev (MuckRock OAuth broker)

**Location:** `backend/app/routers/local_auth.py` (mounted only when `LOCAL_MUCKROCK_AUTH_BROKER=true`)

| Method | Path | Auth | Rate Limit | Description |
|--------|------|------|------------|-------------|
| GET | `/api/auth/login` | None | — | Redirect to MuckRock OAuth authorize URL for localhost dev |
| GET | `/api/auth/callback` | None | — | Exchange OAuth code, mint hosted Supabase session, hand browser back to localhost |

### OSS (Supabase Auth)

**Location:** `backend/app/main.py` (inline endpoint, mounted when `DEPLOYMENT_TARGET == "supabase"`)

| Method | Path | Auth | Rate Limit | Description |
|--------|------|------|------------|-------------|
| GET | `/api/auth/me` | Bearer JWT (Supabase) | — | Get current authenticated user data |

Login, logout, and signup are handled client-side by the Supabase JS client — no backend endpoints needed.

### GET /api/auth/login

Local-dev only. Redirect the user to MuckRock's OAuth authorize URL. The local
frontend navigates here so localhost code can authenticate against hosted data
before deployment.

**Response:** `302 Redirect` to MuckRock authorize endpoint.

---

### GET /api/auth/callback

Local-dev only. Exchange the OAuth authorization code for a hosted Supabase
magiclink, resolve it server-side, then redirect the browser to
`/auth/callback` on localhost with `#access_token=...` and `#refresh_token=...`.

**Query Parameters:**

| Param | Required | Description |
|-------|----------|-------------|
| `code` | Yes | Authorization code from MuckRock |
| `state` | Yes | CSRF state parameter |

**Response:** `302 Redirect` to localhost `/auth/callback`.

---

### GET /api/auth/me

Hosted production no longer serves `/api/auth/me`; the frontend now reads user
state from Supabase and enriches via the `user` Edge Function (`GET /user/me`).

**Response:**
```json
{
  "user_id": "user_xxx",
  "muckrock_id": "user_xxx",
  "username": "journalist42",
  "tier": "team",
  "credits": 4820,
  "timezone": "Europe/Zurich",
  "preferred_language": "en",
  "onboarding_completed": true,
  "needs_initialization": false,
  "upgrade_url": "https://accounts.muckrock.com/plans/70-scoutpost-pro/?source=scoutpost",
  "team_upgrade_url": "https://accounts.muckrock.com/plans/71-scoutpost-team/?source=scoutpost",
  "org_id": "97109cc6-e52e-41e7-adb7-834ab7c6819c",
  "team": {
    "org_id": "97109cc6-e52e-41e7-adb7-834ab7c6819c",
    "org_name": "Newsroom X",
    "seat_count": 3,
    "seat_limit": 5
  }
}
```

For non-team users, `team` is `null` and `org_id` is `null`. The `credits` field shows the org pool balance for team members.

---

### GET /api/auth/status

Get auth status without requiring authentication. Safe to call from unauthenticated pages.

**Auth:** Session cookie (optional)

**Response (authenticated):**
```json
{
  "authenticated": true,
  "user_id": "user_xxx"
}
```

**Response (unauthenticated):**
```json
{
  "authenticated": false
}
```

---

### POST /api/auth/logout

Clear the session cookie and log the user out.

**Auth:** Session cookie

**Response:**
```json
{
  "success": true
}
```

---

### POST /api/auth/webhook

MuckRock webhook receiver for user and organization updates. Verifies HMAC-SHA256 signature and rejects payloads older than 5 minutes.

**Auth:** HMAC-SHA256 signature in `X-Webhook-Signature` header

**Request:**
```json
{
  "event": "user.updated",
  "timestamp": "2026-03-28T10:00:00Z",
  "data": {
    "user_id": "user_xxx",
    "changes": {}
  }
}
```

**Response:**
```json
{
  "received": true
}
```

---

## Onboarding Endpoints

**Location:** `backend/app/routers/onboarding.py`

User onboarding flow — initialize preferences, seed demo data, track tour completion.

| Method | Path | Auth | Rate Limit | Description |
|--------|------|------|------------|-------------|
| POST | `/api/onboarding/initialize` | Session cookie | — | Initialize user prefs (timezone, language, location); seeds demo data |
| GET | `/api/onboarding/status` | Session cookie | — | Check if user completed onboarding |
| POST | `/api/onboarding/tour-complete` | Session cookie | — | Mark onboarding tour as completed |

### POST /api/onboarding/initialize

Initialize user preferences and seed demo data for first-time users.

**Auth:** Session cookie

**Request:**
```json
{
  "timezone": "Europe/Zurich",
  "language": "en",
  "location": {
    "displayName": "Zurich, Switzerland",
    "city": "Zurich",
    "country": "CH"
  }
}
```

**Response:**
```json
{
  "success": true,
  "demo_scout_created": true
}
```

**Notes:**
- The seeded onboarding content is placeholder data only. It is read-only, not scheduled, and does not consume credits.
- The web UI marks placeholder scouts and units with a visible `DEMO` pill so users can distinguish them from live reporting data.

---

### GET /api/onboarding/status

Check whether the authenticated user has completed onboarding.

**Auth:** Session cookie

**Response:**
```json
{
  "onboarding_complete": true,
  "tour_complete": false
}
```

---

### POST /api/onboarding/tour-complete

Mark the onboarding tour as completed for the authenticated user.

**Auth:** Session cookie

**Response:**
```json
{
  "success": true
}
```

---

## Scout Execution Endpoints

Called by AWS Lambda on schedule. Authenticate with `X-Service-Key` header.

**Location:** `backend/app/routers/scouts.py`

### POST /api/scouts/execute

Execute web scout - scrape URL and check criteria.

**Request:**
```json
{
  "url": "https://example.com/news",
  "criteria": "breaking news OR urgent alert",
  "userId": "user_xxx",
  "scraperName": "Breaking News Scout"
}
```

**Response:**
```json
{
  "scraper_status": true,
  "criteria_status": true,
  "summary": "Page contains breaking news about..."
}
```

---

### POST /api/scouts/test

Test scout without triggering notifications or charging credits.

**Request:** Same as `/api/scouts/execute`

**Response:** Same as `/api/scouts/execute`

**Flags:**
- `skip_duplicate_check=True`
- `skip_notification=True`
- `skip_credit_charge=True`

---

### GET /api/scouts/health

Health check for scout endpoints.

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2025-01-07T10:00:00Z",
  "version": "3.0.0",
  "endpoints": [
    "/scouts/execute",
    "/scouts/test"
  ],
  "note": "pulse moved to /pulse/*"
}
```

---

## Pulse Endpoints

**Location:** `backend/app/routers/pulse.py`

AI-curated local news digests. **Always sends notification** regardless of results.

### POST /api/pulse/search

UI-triggered pulse search. Rate limited: 10 requests/minute.

**Auth:** Session cookie

**Request:**
```json
{
  "location": {
    "displayName": "Zurich, Switzerland",
    "city": "Zurich",
    "country": "CH"
  },
  "category": "news",
  "criteria": "climate tech startups",
  "custom_filter_prompt": null
}
```

**Response:**
```json
{
  "status": "completed",
  "mode": "pulse",
  "category": "news",
  "task_completed": true,
  "articles": [
    {
      "title": "Zurich Climate Startup Raises $10M",
      "url": "https://example.com/article",
      "source": "Tech News",
      "summary": "A Zurich-based startup...",
      "date": "2025-01-06",
      "imageUrl": null,
      "verified": true
    }
  ],
  "totalResults": 5,
  "search_queries_used": ["Zurich local news", "..."],
  "processing_time_ms": 45000,
  "summary": "Found 5 local news articles..."
}
```

---

### POST /api/pulse/execute

Lambda-triggered pulse execution for scheduled scouts.

**Auth:** `X-Service-Key` header

**Request:**
```json
{
  "location": {
    "displayName": "Zurich, Switzerland",
    "city": "Zurich",
    "country": "CH",
    "countryCode": "CH"
  },
  "criteria": "climate tech startups",
  "topic": "Climate",
  "userId": "user_xxx",
  "scraperName": "Zurich Daily News"
}
```

In `PulseExecuteRequest`, `topic` is an organizational tag (from the SCRAPER# record) used for info unit tagging, while `criteria` is the search driver. At least one of `location` or `criteria` is required. **Backward compatibility:** if `criteria` is empty but `topic` is set, `topic` is copied to `criteria` automatically (for old SCRAPER# records that stored the search term in `topic`).

**Response:**
```json
{
  "scraper_status": true,
  "criteria_status": true,
  "summary": "Found 5 news articles for Zurich",
  "articles_count": 5,
  "notification_sent": true
}
```

**Note:** `PulseSearchRequest` does not have a `topic` field. The `criteria` field is the search driver (keywords, topic, or specific criteria). At least one of `location` or `criteria` is required.

**Flow:**
1. Call `PulseOrchestrator.search_news()` with location and/or criteria
2. Extract articles from AI response
3. Store information units in DynamoDB
4. Send notification via Resend (always)
5. Decrement user credits (MuckRock entitlements)

---

### GET /api/pulse/health

Health check for pulse endpoints.

---

## Social Scout Endpoints

**Location:** `backend/app/routers/social.py`

Social media profile monitoring. Scrapes profiles via Apify, diffs posts against baseline, and optionally matches criteria.

### POST /api/social/test

Validate a social media profile and perform baseline scan.

**Auth:** Session cookie

**Request:**
```json
{
  "platform": "instagram",
  "handle": "cityofzurich"
}
```

**Response:**
```json
{
  "valid": true,
  "post_count": 15,
  "posts": [
    {
      "id": "abc123",
      "text": "New park opening...",
      "timestamp": "2026-03-15T10:00:00Z",
      "author": "cityofzurich"
    }
  ]
}
```

---

### POST /api/social/execute

Full social scout execution — scrape, diff against baseline, summarize/match criteria, notify, store records.

**Auth:** `X-Service-Key` header

**Request:**
```json
{
  "platform": "instagram",
  "handle": "cityofzurich",
  "userId": "user_xxx",
  "scraperName": "Zurich IG Monitor",
  "mode": "summarize",
  "criteria": null,
  "topic": null,
  "track_removals": false
}
```

**Response:**
```json
{
  "scraper_status": true,
  "criteria_status": true,
  "summary": "3 new posts found on @cityofzurich",
  "new_posts_count": 3,
  "removed_posts_count": 0,
  "notification_sent": true
}
```

---

## Civic Scout Endpoints

**Location:** `backend/app/routers/civic.py`

Council website monitoring. Crawls council domains to discover relevant pages, then executes on schedule to detect new PDFs, extract promises, and notify.

### POST /api/civic/discover (session auth)

Crawl a council domain and return AI-ranked candidate URLs (meeting minutes, agendas, protocols).

**Auth:** Session cookie

**Rate limit:** 3 requests/hour

**Request:**
```json
{
  "root_domain": "stadtrat.example.gov"
}
```

**Response:**
```json
{
  "candidates": [
    {
      "url": "https://stadtrat.example.gov/protokolle",
      "description": "Meeting minutes and protocols archive",
      "confidence": 0.92
    },
    {
      "url": "https://stadtrat.example.gov/traktanden",
      "description": "Council agenda listings",
      "confidence": 0.74
    }
  ]
}
```

---

### POST /api/civic/execute (service key auth)

Full civic scout execution — fetch tracked URLs, hash content, detect new PDFs, parse with Firecrawl, extract promises, store records, notify.

**Auth:** `X-Service-Key` header

**Request:**
```json
{
  "user_id": "user_abc123",
  "scraper_name": "Zurich Council Monitor",
  "tracked_urls": [
    "https://stadtrat.example.gov/protokolle",
    "https://stadtrat.example.gov/traktanden"
  ],
  "criteria": "housing policy",
  "language": "en"
}
```

**Response:**
```json
{
  "status": "ok",
  "summary": "Found 3 promise(s) in 1 new document(s).",
  "promises_found": 3,
  "new_pdf_urls": ["https://stadtrat.example.gov/protokolle/2026-03-19.pdf"],
  "is_duplicate": false
}
```

**`status` values:**
| Value | Meaning |
|-------|---------|
| `"ok"` | Execution succeeded, new PDFs processed |
| `"no_changes"` | Content hash unchanged — no new PDFs |
| `"error"` | Execution error (exception message in `summary`) |

---

### POST /api/civic/notify-promises (service key auth)

Send a digest email for promises surfaced by the `promise-checker-lambda`. Updates promise status to `"notified"`.

**Auth:** `X-Service-Key` header

**Request:**
```json
{
  "user_id": "user_abc123",
  "scraper_name": "Zurich Council Monitor",
  "promises": [
    {
      "promise_id": "a1b2c3d4e5f6a7b8",
      "promise_text": "New bike lanes on Bahnhofstrasse by Q4 2026",
      "due_date": "2026-12-31",
      "source_url": "https://stadtrat.example.gov/protokolle/2026-03-19.pdf"
    }
  ],
  "language": "en"
}
```

**Response:**
```json
{
  "notification_sent": true,
  "promises_count": 1
}
```

---

## Scheduling Endpoints

**Location:** `backend/app/routers/scraper.py`

### POST /api/scrapers/monitoring

Schedule a new scout via AWS EventBridge.

**Request:**
```json
{
  "name": "Daily Zurich News",
  "scout_type": "pulse",
  "regularity": "daily",
  "day_number": 1,
  "time": "08:00",
  "monitoring": "EMAIL",
  "location": {
    "displayName": "Zurich, Switzerland",
    "city": "Zurich",
    "country": "CH"
  }
}
```

| Scout Type | Required Fields |
|------------|-----------------|
| `web` | `url`, `criteria` |
| `pulse` | at least one of `location` or `criteria` |
| `social` | `platform`, `handle` |

**Response:**
```json
{
  "name": "Daily Zurich News",
  "scout_type": "pulse",
  "regularity": "daily",
  "cron_expression": "0 8 * * ? *",
  "timezone": "Europe/Zurich",
  "metadata": {
    "next_run": "2025-01-08T08:00:00+01:00"
  }
}
```

**Flow:**
1. Build cron expression from regularity/day/time
2. Forward request to AWS API Gateway (`/schedule_scraper`)
3. AWS Lambda creates EventBridge schedule + DynamoDB record

---

### GET /api/scrapers/active

Get all active scouts for authenticated user.

**Response:**
```json
{
  "user": "user_xxx",
  "scrapers": [
    {
      "scraper_name": "Daily Zurich News",
      "scout_type": "pulse",
      "regularity": "daily",
      "location": { "displayName": "Zurich, Switzerland" },
      "last_run": {
        "last_run": "01-07-2025 08:00",
        "scraper_status": true,
        "criteria_status": true,
        "summary": "Found 5 news articles...",
        "notification_sent": true
      }
    }
  ]
}
```

---

### DELETE /api/scrapers/active/{scraper_name}

Delete a scheduled scout.

**Response:**
```json
{
  "rule_name": "scout-xxx-Daily-Zurich-News",
  "status": "deleted"
}
```

---

### POST /api/scrapers/run-now

Manually trigger a scout execution ("Run Now"). Authenticates the user via session cookie, reads the SCRAPER# record from DynamoDB, then proxies to the appropriate internal execute endpoint (`/api/scouts/execute`, `/api/pulse/execute`, or `/api/social/execute`) with `X-Service-Key` auth. Stores a TIME# record from the response.

**Auth:** Session cookie

**Request:**
```json
{
  "scraper_name": "Daily-Zurich-News"
}
```

**Response:**
```json
{
  "scraper_status": true,
  "criteria_status": true,
  "summary": "Found 5 news articles for Zurich.",
  "notification_sent": true
}
```

Response fields vary by scout type (matches the execute endpoint response).

---

### POST /api/scrapers/monitoring/validate

Validate user has sufficient credits for monitoring setup.

**Request:**
```json
{
  "channel": "website",
  "regularity": "daily",
  "scout_type": "pulse"
}
```

**Response:**
```json
{
  "valid": true,
  "per_run_cost": 1,
  "monthly_cost": 30,
  "current_credits": 100,
  "remaining_after": 70
}
```

---

### POST /api/scrapers/charge

Deduct credits from the user's balance. Returns the updated balance.

**Auth:** Session cookie

**Request:**
```json
{
  "amount": 2,
  "reason": "pulse_run"
}
```

**Response:**
```json
{
  "success": true,
  "credits_deducted": 2,
  "new_balance": 98
}
```

---

## Notification Rules

| Scout Type | When to Notify |
|------------|----------------|
| `web` | `criteria_status == true` |
| `pulse` | **Always** (every run) |
| `civic` | When `promises_found > 0` |

---

## Deduplication

Pulse scouts use two-phase deduplication to prevent the same news story from being sent multiple times:

### Phase 1: Content Hash Check (Full 90-day TTL)
- **Source-agnostic fingerprint**: Same fact from nrk.no and vg.no produces identical hash
- Catches exact/near-exact matches across all stored units
- Filters by user (same fact for different users is not a duplicate)

### Phase 2: Semantic Embedding Check (30-day window)
- Generates embeddings for content similarity comparison
- Catches paraphrased duplicates (similar facts with different wording)
- Limited to 100 comparisons for performance

### Article Deduplication
Before sending notifications, routers deduplicate articles by URL since one article can produce multiple atomic units.

---

## Information Units Endpoints

**Location:** `backend/app/routers/units.py`

Manage information units extracted from scout results for the Feed panel.

**Auth:** Session cookie (user endpoints)

### GET /api/units/locations

Get distinct locations where user has information units.

**Response:**
```json
{
  "locations": [
    "US#CA#San Francisco",
    "US#NY#New York",
    "CH#_#Zurich"
  ]
}
```

---

### GET /api/units

Get information units for a specific location.

**Query Parameters:**

| Param | Required | Description |
|-------|----------|-------------|
| `country` | Yes | Country code (e.g., `US`) |
| `state` | No | State code (e.g., `CA`) |
| `city` | No | City name |
| `displayName` | Yes | Full display name from MapTiler |
| `limit` | No | Max units to return (default: 50, max: 100) |

**Request:**
```
GET /api/units?country=US&state=CA&city=San%20Francisco&displayName=San%20Francisco,%20California,%20USA&limit=20
```

**Response:**
```json
{
  "units": [
    {
      "unit_id": "unit_xxx",
      "pk": "USER#user_xxx#LOC#US#CA#San Francisco",
      "sk": "1736123456789",
      "title": "New Climate Initiative Announced",
      "summary": "City officials announced a $50M climate investment...",
      "source_url": "https://sfchronicle.com/article/123",
      "source_domain": "sfchronicle.com",
      "scout_type": "pulse",
      "scout_id": "SF Daily News",
      "created_at": "2025-01-06T10:00:00Z",
      "used_in_article": false
    }
  ],
  "count": 1
}
```

---

### PATCH /api/units/mark-used

Mark units as used in an article. Removes TTL to preserve indefinitely.

**Request:**
```json
{
  "unit_keys": [
    {
      "pk": "USER#user_xxx#LOC#US#CA#San Francisco",
      "sk": "1736123456789"
    }
  ]
}
```

**Response:**
```json
{
  "marked_count": 1,
  "total_requested": 1
}
```

**Security:** Validates that `pk` starts with `USER#{current_user_id}#` to prevent cross-user modification.

---

### GET /api/units/topics

Get distinct topics across all of the user's information units.

**Auth:** Session cookie

**Response:**
```json
{
  "topics": ["Climate", "Housing", "Transport"]
}
```

---

### GET /api/units/all

Get all unused information units for the authenticated user.

**Auth:** Session cookie

**Response:**
```json
{
  "units": [...],
  "count": 42
}
```

---

### GET /api/units/by-topic

Get information units filtered by topic.

**Auth:** Session cookie

**Query Parameters:**

| Param | Required | Description |
|-------|----------|-------------|
| `topic` | Yes | Topic tag to filter by |

**Request:**
```
GET /api/units/by-topic?topic=Climate
```

**Response:**
```json
{
  "units": [...],
  "count": 12
}
```

---

### GET /api/units/by-article/{article_id}

Get information units associated with a specific article.

**Auth:** Session cookie

**Response:**
```json
{
  "units": [...],
  "count": 5
}
```

---

### GET /api/units/unused

Get only unused information units for a specific location.

**Auth:** Session cookie

**Query Parameters:**

| Param | Required | Description |
|-------|----------|-------------|
| `country` | Yes | Country code (e.g., `US`) |
| `state` | No | State code (e.g., `CA`) |
| `city` | No | City name |
| `displayName` | Yes | Full display name from MapTiler |

**Request:**
```
GET /api/units/unused?country=US&state=CA&city=San%20Francisco&displayName=San%20Francisco,%20California,%20USA
```

**Response:**
```json
{
  "units": [...],
  "count": 18
}
```

---

## Credit Costs

All credit costs are defined in `backend/app/utils/credits.py`.

| Operation | Cost |
|-----------|------|
| Web data extraction | 1 credit/page |
| Social data extraction | 6 credits |
| Local Pulse scout (scheduled) | 2 credits/run |
| Local Data scout (scheduled) | 1 credit/run |
| Local news search (on-demand) | Free |

Scheduled monitoring multiplies per-run cost by frequency: daily (30x), weekly (4x), monthly (1x).

---

## User Preferences Endpoints

**Location:** `backend/app/routers/user.py`

**Auth:** Session cookie

### GET /api/user/preferences

Get user's preferences.

**Response:**
```json
{
  "preferred_language": "en",
  "timezone": "Europe/Zurich",
  "excluded_domains": ["tabloid.com"]
}
```

---

### PUT /api/user/preferences

Update user preferences. At least one field must be provided.

**Request:**
```json
{
  "preferred_language": "fr",
  "timezone": "Europe/Paris",
  "excluded_domains": ["tabloid.com"]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `preferred_language` | string | ISO 639-1 code (2-5 chars) |
| `timezone` | string | IANA timezone identifier |
| `excluded_domains` | string[] | Domains to exclude from Pulse (max 50) |

**Response:**
```json
{
  "success": true,
  "preferred_language": "fr"
}
```

---

## V1 External API

**Location:** `backend/app/routers/v1.py`

Programmatic API for external integrations. Uses API key authentication (not session cookies).

### Key Management

Manage API keys for programmatic access. Authenticated via session cookie.

| Method | Path | Auth | Rate Limit | Description |
|--------|------|------|------------|-------------|
| POST | `/api/v1/keys` | Session cookie | 10/min | Create new API key (raw key returned once) |
| GET | `/api/v1/keys` | Session cookie | 10/min | List API keys (prefix only) |
| DELETE | `/api/v1/keys/{key_id}` | Session cookie | 10/min | Revoke API key |

#### POST /api/v1/keys

Create a new API key. The raw key is returned only once — store it securely.

**Auth:** Session cookie

**Rate limit:** 10 requests/minute

**Request:**
```json
{
  "name": "My Integration"
}
```

**Response:**
```json
{
  "key_id": "key_abc123",
  "name": "My Integration",
  "key": "coj_live_xxxxxxxxxxxxxxxxxxxxxxxx",
  "prefix": "coj_live_xxxx",
  "created_at": "2026-03-28T10:00:00Z"
}
```

---

#### GET /api/v1/keys

List all API keys for the authenticated user. Only the key prefix is returned.

**Auth:** Session cookie

**Rate limit:** 10 requests/minute

**Response:**
```json
{
  "keys": [
    {
      "key_id": "key_abc123",
      "name": "My Integration",
      "prefix": "coj_live_xxxx",
      "created_at": "2026-03-28T10:00:00Z",
      "last_used": "2026-03-28T12:00:00Z"
    }
  ]
}
```

---

#### DELETE /api/v1/keys/{key_id}

Revoke an API key. The key becomes immediately unusable.

**Auth:** Session cookie

**Rate limit:** 10 requests/minute

**Response:**
```json
{
  "success": true,
  "key_id": "key_abc123"
}
```

---

### Scout Management

Manage scouts via API key. All endpoints require `Authorization: Bearer <api_key>` header.

| Method | Path | Auth | Rate Limit | Description |
|--------|------|------|------------|-------------|
| GET | `/api/v1/scouts` | API key | 60/min | List all scouts |
| POST | `/api/v1/scouts` | API key | 10/min | Create scout with schedule |
| GET | `/api/v1/scouts/{name}` | API key | 60/min | Get scout details + recent runs |
| DELETE | `/api/v1/scouts/{name}` | API key | 10/min | Delete scout + schedule |
| POST | `/api/v1/scouts/{name}/run` | API key | 5/min | Manually trigger scout |

#### GET /api/v1/scouts

List all scouts for the authenticated API key owner.

**Auth:** API key

**Rate limit:** 60 requests/minute

**Response:**
```json
{
  "scouts": [
    {
      "name": "Daily Zurich News",
      "scout_type": "pulse",
      "regularity": "daily",
      "status": "active",
      "last_run": "2026-03-28T08:00:00Z"
    }
  ]
}
```

---

#### POST /api/v1/scouts

Create a new scout with a schedule.

**Auth:** API key

**Rate limit:** 10 requests/minute

**Request:**
```json
{
  "name": "Daily Zurich News",
  "scout_type": "pulse",
  "regularity": "daily",
  "time": "08:00",
  "location": {
    "displayName": "Zurich, Switzerland",
    "city": "Zurich",
    "country": "CH"
  },
  "criteria": "climate policy"
}
```

**Response:**
```json
{
  "name": "Daily Zurich News",
  "scout_type": "pulse",
  "regularity": "daily",
  "status": "active",
  "next_run": "2026-03-29T08:00:00Z"
}
```

---

#### GET /api/v1/scouts/{name}

Get scout details including recent run history.

**Auth:** API key

**Rate limit:** 60 requests/minute

**Response:**
```json
{
  "name": "Daily Zurich News",
  "scout_type": "pulse",
  "regularity": "daily",
  "status": "active",
  "last_run": "2026-03-28T08:00:00Z",
  "recent_runs": [
    {
      "timestamp": "2026-03-28T08:00:00Z",
      "scraper_status": true,
      "criteria_status": true,
      "summary": "Found 5 news articles for Zurich"
    }
  ]
}
```

---

#### DELETE /api/v1/scouts/{name}

Delete a scout and its associated EventBridge schedule.

**Auth:** API key

**Rate limit:** 10 requests/minute

**Response:**
```json
{
  "success": true,
  "name": "Daily Zurich News",
  "status": "deleted"
}
```

---

#### POST /api/v1/scouts/{name}/run

Manually trigger a scout execution.

**Auth:** API key

**Rate limit:** 5 requests/minute

**Response:**
```json
{
  "scraper_status": true,
  "criteria_status": true,
  "summary": "Found 5 news articles for Zurich",
  "notification_sent": true
}
```

---

### Information Units

Query information units via API key. All endpoints require `Authorization: Bearer <api_key>` header.

| Method | Path | Auth | Rate Limit | Description |
|--------|------|------|------------|-------------|
| GET | `/api/v1/units` | API key | 60/min | List units (filter by location/topic/scout) |
| GET | `/api/v1/units/search` | API key | 30/min | Semantic search units |

#### GET /api/v1/units

List information units. Supports filtering by location, topic, or scout name.

**Auth:** API key

**Rate limit:** 60 requests/minute

**Query Parameters:**

| Param | Required | Description |
|-------|----------|-------------|
| `location` | No | Location filter (e.g., `US#CA#San Francisco`) |
| `topic` | No | Topic tag filter |
| `scout` | No | Scout name filter |
| `limit` | No | Max results (default: 50, max: 100) |

**Request:**
```
GET /api/v1/units?topic=Climate&limit=10
```

**Response:**
```json
{
  "units": [
    {
      "unit_id": "unit_xxx",
      "title": "New Climate Initiative Announced",
      "summary": "City officials announced a $50M climate investment...",
      "source_url": "https://sfchronicle.com/article/123",
      "scout_type": "pulse",
      "created_at": "2026-03-28T10:00:00Z"
    }
  ],
  "count": 1
}
```

---

#### GET /api/v1/units/search

Semantic search across information units using vector similarity.

**Auth:** API key

**Rate limit:** 30 requests/minute

**Query Parameters:**

| Param | Required | Description |
|-------|----------|-------------|
| `q` | Yes | Search query |
| `limit` | No | Max results (default: 10, max: 50) |

**Request:**
```
GET /api/v1/units/search?q=renewable%20energy%20investment&limit=5
```

**Response:**
```json
{
  "units": [
    {
      "unit_id": "unit_xxx",
      "title": "New Climate Initiative Announced",
      "summary": "City officials announced a $50M climate investment...",
      "source_url": "https://sfchronicle.com/article/123",
      "score": 0.89,
      "created_at": "2026-03-28T10:00:00Z"
    }
  ],
  "count": 1
}
```

---

## Execution Flow Summary

### Lambda → FastAPI Flow

```
┌──────────────────┐
│  EventBridge     │
│  Cron Trigger    │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  scraper-lambda  │
│  Route by type   │
└────────┬─────────┘
         │
         │ POST /api/{endpoint}/execute
         │ X-Service-Key: xxx
         ▼
┌──────────────────────────────────────────────────────┐
│                    FastAPI                           │
│                                                      │
│  Routes by scout_type:                              │
│  - web:          POST /api/scouts/execute           │
│  - pulse:        POST /api/pulse/execute            │
│  - social:       POST /api/social/execute           │
│                                                      │
│  1. Verify X-Service-Key                            │
│  2. Execute scout logic + AI analysis               │
│  3. Store information units (pulse)                 │
│  4. Send notification (Resend) if criteria met      │
│  5. Decrement credits (MuckRock entitlements)        │
│  6. Return result                                   │
│                                                      │
└────────┬─────────────────────────────────────────────┘
         │
         │ JSON response
         ▼
┌──────────────────┐
│  scraper-lambda  │
│  Store TIME#     │
│  Emit metrics    │
└──────────────────┘
```

---

## Error Handling

All endpoints return valid JSON responses, never raw HTTP exceptions.

```json
{
  "scraper_status": false,
  "criteria_status": false,
  "summary": "Error: Connection timeout to external service",
  "notification_sent": false
}
```

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `INTERNAL_SERVICE_KEY` | Key for Lambda authentication |
| `OPENROUTER_API_KEY` | LLM access via OpenRouter |
| `FIRECRAWL_API_KEY` | Web search/scrape API |
| `RESEND_API_KEY` | Email notifications |
| `AWS_API_BASE_URL` | AWS API Gateway URL |

---

## File References

| File | Purpose |
|------|---------|
| `backend/app/routers/auth.py` | Auth endpoints (OAuth login, callback, logout, webhook) |
| `backend/app/routers/onboarding.py` | Onboarding endpoints (initialize, status, tour) |
| `backend/app/routers/scouts.py` | Web scout execution |
| `backend/app/routers/pulse.py` | Pulse endpoints (UI + Lambda) |
| `backend/app/routers/social.py` | Social Scout endpoints (UI + Lambda) |
| `backend/app/routers/civic.py` | Civic Scout endpoints (discover + execute) |
| `backend/app/routers/scraper.py` | Scheduling endpoints |
| `backend/app/routers/units.py` | Information units (feed data) |
| `backend/app/routers/user.py` | User preferences (language, timezone, CMS config) |
| `backend/app/routers/v1.py` | V1 external API (keys, scouts, units) |
| `backend/app/schemas/scouts.py` | Web scout request/response schemas |
| `backend/app/schemas/pulse.py` | Pulse request/response schemas |
| `backend/app/schemas/social.py` | Social Scout request/response schemas |
| `backend/app/services/pulse_orchestrator.py` | Beat Scout (type `pulse`) orchestrator |
| `backend/app/services/social_orchestrator.py` | Social Scout orchestrator (Apify scrapers) |
| `backend/app/services/notification_service.py` | Unified email notifications (markdown→HTML) |
| `backend/app/services/execution_deduplication.py` | Execution-level dedup (EXEC# records, embeddings) |
| `backend/app/services/atomic_unit_service.py` | Fact-level dedup + unit extraction |
| `backend/app/services/url_validator.py` | SSRF protection |

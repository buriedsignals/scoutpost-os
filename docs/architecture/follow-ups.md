# Follow-ups: deferred cleanup and hardening

Backlog of work intentionally left out of recent PRs (#99 hardening / #101 combined sweep + audit) because each item either needs an external action, needs its own verification pass, or is a wider refactor that "working code, don't touch" applies to. Each entry is one surgical ticket — take them one at a time, keep PRs small.

**Legend**: Impact (H/M/L) · Risk (H/M/L) · Cost (H/M/L — rough dev hours) · Where

---

## 1. Cloudflare Cache / Transform / Rate-limit Rules — zone-level

- **What**: Set up per-path cache and rate rules at the Cloudflare zone `scoutpost.ai` so edge behavior is explicit, not dependent on defaults that bit us during the 2026-04-24 blank-page incident.
- **Impact H · Risk L · Cost L** — CF dashboard only, zero code change.
- **Where**: Cloudflare dashboard → Caching → Cache Rules (and Security → WAF → Rate Limiting Rules).
- **Concrete rules to add**:
  1. **Cache Rule A**: path starts with `/_app/immutable/` → Eligible for cache, Edge TTL 1 year, **respect origin `Cache-Control: immutable`** (origin is already stamping this after PR #101).
  2. **Cache Rule B**: path `eq /` OR ends with `.html` OR Content-Type `text/html` → **Bypass cache** (edge TTL 0, browser TTL 0). Prevents #99-class regressions even if origin misconfigures `Cache-Control` on HTML.
  3. **Cache Rule C**: path starts with `/api/` → **Bypass cache**. API responses must never land at edge.
  4. **Cache Rule D**: path starts with `/static/` → cache everything, edge 30d. Email images (`logo-cojournalist.png` etc.) are stable.
  5. **Rate Limiting Rule**: `POST /api/feedback` and `/api/auth/callback` → 10 req/min/IP → Managed Challenge above. Low-volume today; cheap to set up before abuse.
  6. **Transform Rule**: set `Permissions-Policy: camera=(), microphone=(), geolocation=()` at the edge so origin can't forget it.
- **Verification after apply**: `curl -I https://scoutpost.ai/_app/immutable/entry/<real-hash>.js | grep -i cache-control` → should match origin's `immutable`, not be overridden to `max-age=14400`. `curl -I https://scoutpost.ai/` → no `max-age=14400` (Rule B bypasses).
- **Deferred because**: needs Cloudflare dashboard access; out of band from the code PRs.

---

## 2. `normalize_api_prefix` middleware — sunset

- **What**: `backend/app/main.py` has a middleware that rewrites `/api/api/*` → `/api/*` to forgive stale frontend bundles. After #101 it logs at `DEBUG` (was `WARNING`). If zero hits for 30 days of production traffic, delete the middleware entirely.
- **Impact L · Risk L · Cost L** — 15 minutes.
- **Where**: `backend/app/main.py::normalize_api_prefix` (around line 358-376 on post-#101 main).
- **Verification that it's safe to remove**: scan Render logs for `Normalized duplicated API prefix` — if **no** hits across 30 days of production logs, delete. If any hits, find the stale client and push a frontend bundle update first.
- **Fix**: delete the `@app.middleware("http") async def normalize_api_prefix(...)` block; it's self-contained and has no other references.
- **Deferred because**: need 30 days of post-deploy observation before deciding; risks breaking old browser tabs still holding stale bundles otherwise.

---

## 3. GDPR Art. 15 data export — no self-service endpoint

- **What**: The legacy FastAPI `GET /api/user/data-export` route was removed together with `/api/user/*`, `/api/units/*`, `/api/onboarding/*` and the scout/execution/run/unit storage adapters. It had no UI and no client requests in Render logs (2026-09-21 → 2026-10-06). No Edge Function replaces it; until one exists, Art. 15 access requests need a manual export.
- **Impact M · Risk L · Cost M** — a `user` Edge Function export route if self-service export becomes a requirement.
- **Where**: `supabase/functions/user/` (new route); RLS-scoped reads of `user_preferences`, `scouts`, `scout_runs`, `information_units`.
- **Deferred because**: removal was approved on zero usage; build the Edge Function route only when self-service export is required.

---

## 4. Large frontend components — don't refactor preemptively

- **What**: Three `.svelte` files over 600 lines — `frontend/src/lib/components/modals/ScoutScheduleModal.svelte` (995), `frontend/src/lib/components/news/BeatScoutView.svelte` (985), `frontend/src/lib/components/panels/UnitDrawer.svelte` (663).
- **Impact L · Risk H · Cost H** — a split is a 1-2 day refactor each and risks regression in a busy area of the UI.
- **Where**: above paths.
- **Deferred because**: user's stated philosophy — production is working, simplify only when a feature forces a split.

---

## 5. i18n dead-key audit — Paraglide may be carrying unused keys

- **What**: `frontend/messages/en.json` has ~777 keys. Paraglide's strict mode only fails on *missing* keys, not unused ones. A sweep to remove dead keys would shave translation maintenance for all 12 locales.
- **Impact L · Risk L · Cost M** — ~1h for the grep + removal + retranslation tooling pass.
- **Where**: `frontend/messages/*.json` + any `m.*()` references across `frontend/src/`.
- **Verification**: for each key in `en.json`, `grep -r "m\.<key>\|messages\.<key>\|t('\\b<key>\\b'" frontend/src` — remove if zero hits. Mirror removals across all 12 language files.
- **Deferred because**: cosmetic; wait until a natural moment (e.g. before rebranding or a big copy pass).

---

## 6. `bump_credits.py` docstring pointer

- **What**: `backend/scripts/bump_credits.py` (post-#audit) has a small docstring pointer to "see follow-ups.md for related cleanup items" — that is *this* file. Keep in sync if any of items 1-5 change.
- **Impact L · Risk L · Cost L** — nothing to do now; note for future maintainers.

---

## 7. `SPAStaticFiles` — unregistered `/api/*` returns 500 instead of 404

- **What**: `backend/app/main.py::SPAStaticFiles.get_response` does `if path.startswith("api/"): raise RuntimeError("Not a static file")` for any `/api/*` path that isn't matched by a FastAPI router. The RuntimeError bubbles to `global_exception_handler` and becomes `HTTP 500 {"error":"Internal server error"}`. A client hitting an unregistered API path sees a 500 where a 404 is the correct shape.
- **Impact L · Risk L · Cost L** — 2-line change + 1 unit test. 10 minutes.
- **Where**: `backend/app/main.py` inside `class SPAStaticFiles(StaticFiles)` — the early `if path.startswith("api/"):` branch.
- **Fix**: replace `raise RuntimeError("Not a static file")` with:
  ```python
  return Response(status_code=404, headers=_NO_STORE_HEADERS)
  ```
  (Imports `_NO_STORE_HEADERS` is already in the same module.)
- **Verification**:
  ```bash
  curl -sI https://scoutpost.ai/api/bogus-does-not-exist | head -2
  # expect post-fix: HTTP/2 404 (currently: HTTP/2 500)
  curl -sI https://scoutpost.ai/api/auth/has-users | head -2
  # expect post-fix on SaaS: HTTP/2 404 (route removed; currently 500 because of same bug)
  ```
- **Deferred because**: security-intent of D3 (no unauthenticated information disclosure from `/api/auth/has-users`) is already satisfied — the endpoint returns `{"error":"Internal server error"}` not `{"has_users": true}`. Fixing is purely about surfacing correct HTTP semantics so clients can distinguish "not found" from "server crash." Low urgency; ship in its own small PR alongside other L·L·L items.

---

## Principle

If the entry says "impact L · risk L · cost L", ship it opportunistically. If it says risk M or H, ship it in its own PR with explicit verification. Never bundle an H-risk cleanup with a feature.

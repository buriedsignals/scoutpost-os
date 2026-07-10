# Frontend (SvelteKit)

## Project-Wide Rules

Read the nearest parent `AGENTS.md` / `AGENTS.md` before editing; its session preflight points to the canonical coding-rules skill. This file only adds directory-specific context.

## Structure

```
frontend/src/
├── app.html             # HTML shell
├── app.css              # Global styles (Tailwind)
├── routes/              # SvelteKit pages
│   ├── +layout.svelte   # Root layout with auth
│   ├── +page.svelte     # Home/dashboard
│   ├── pricing/         # Pricing page
│   └── ...
└── lib/
    ├── api-client.ts    # Typed API client
    ├── types.ts         # TypeScript types
    ├── components/      # UI components
    │   ├── ui/          # Base components (buttons, inputs)
    │   ├── modals/      # Modal dialogs
    │   ├── panels/      # Side panels
    │   ├── views/       # Main view components
    │   ├── news/        # News-related components
    │   └── sidebars/    # Sidebar components
    ├── stores/          # Svelte stores (state)
    └── utils/           # Helper functions
        └── tooltip.ts   # Custom tooltip action for Svelte
```

## Key Components

| Directory | Purpose |
|-----------|---------|
| `components/ui/` | Reusable UI primitives (TopicChips, LocationAutocomplete, etc.) |
| `components/modals/` | Scout creation, settings, scheduling, UpgradeModal |
| `components/views/` | Main content views |
| `components/news/` | News article display (SmartScoutView, SocialScoutView) |

## State Management

Svelte stores in `lib/stores/`:
- `auth.ts` - deployment-aware auth loader
- `auth-supabase.ts` - primary auth store post-cutover. Used for both OSS Supabase auth and hosted MuckRock-on-Supabase flows.
- `location.ts` - Shared location state (used by Beat Scout, WebScout)
- `notifications.ts` - In-app notification state
- `pulse.ts` - Beat Scout shared state (historical file name; canonical type `beat`)
- `recent-locations.ts` - Recently used locations cache

## API Client

`lib/api-client.ts` - Typed wrapper for backend API calls. Handles:
- Auth via Bearer JWT from Supabase session for the main post-cutover surface
- Error handling
- Type safety

**Key Methods:**
- `searchPulse()` - Beat Scout search with optional criteria (historical method name; POST /pulse/search)

## Scout Topics

Scout topics are independent tags, even though the API/UI payload stores them as
a comma-separated string. Use `src/lib/utils/topics.ts` whenever rendering,
filtering, counting, or suggesting topics:

- `parseTopicTags()` for display/chips
- `collectTopicCounts()` for filter dropdowns and suggestions
- `topicMatches()` for workspace filtering

Do not compare `scout.topic` as a single opaque string in frontend filtering.
`housing, real estate, Pontresina` must behave as three separate tags.

## Environment Variables (Build-time)

These must be set during Docker build:
- `PUBLIC_MAPTILER_API_KEY` - Geocoding for location autocomplete

### Local auth split — important

Private repo daily SaaS testing uses:

- `npm run dev`
- `PUBLIC_MUCKROCK_ENABLED=true`
- `PUBLIC_MUCKROCK_BROKER_URL=http://localhost:5173/api/auth/login`
- `PUBLIC_MUCKROCK_POST_LOGIN_REDIRECT=http://localhost:5173/auth/callback`

That path must keep the browser on localhost while authenticating against the
hosted Supabase project. It is **not** the same as:

- `npm run dev:supabase-local-demo` — disposable local Supabase Auth + demo data
- the deployed hosted broker — diagnostic only, not the daily local default

If you change login flow code, verify that `/docs` and `/skills` stay same-origin
on localhost and that `/api/auth/login` on localhost redirects to MuckRock with
`redirect_uri=http://localhost:5173/api/auth/callback`.

Hosted production uses `PUBLIC_DEPLOYMENT_TARGET=supabase` and
`PUBLIC_MUCKROCK_ENABLED=true`. That combination must keep
`$lib/stores/auth.ts` on `auth-supabase.ts`; the MuckRock-specific branch lives
inside `auth-supabase.ts -> login()`. Do not route hosted production through
`auth-muckrock.ts`, and do not collapse `auth-supabase.ts -> login()` to
plain `/login`.

## i18n (Paraglide)

Internationalization uses [Paraglide JS](https://inlang.com/m/gerre34r) with inlang message format.

**Message files:** `messages/{languageTag}.json` (e.g. `messages/en.json`)

**Generated output:** `src/lib/paraglide/` (gitignored, must be compiled)

**Adding a new i18n key:**

1. Add the key to `messages/en.json` (camelCase after prefix, e.g. `"feed_noLocations": "No locations")`)
2. **Add the same key to ALL 12 language files** — `da.json`, `de.json`, `es.json`, `fi.json`, `fr.json`, `it.json`, `nl.json`, `no.json`, `pl.json`, `pt.json`, `sv.json` (use English as fallback)
3. Recompile paraglide: `npm run paraglide:compile`
4. Import and use: `import * as m from '$lib/paraglide/messages'` → `m.feed_noLocations()`
5. **Verify:** Run `npm run check` — it will fail with "Property does not exist" if any key is missing

**CRITICAL: Always use `npm run paraglide:compile` (or the full command below).** Do NOT run the bare `npx @inlang/paraglide-js compile --project ./project.inlang` — it omits the `--outdir` and `--strategy` flags, compiling to the wrong directory (`src/paraglide/` instead of `src/lib/paraglide/`).

```bash
# Correct command (what npm run paraglide:compile runs):
paraglide-js compile --project ./project.inlang --outdir ./src/lib/paraglide --strategy localStorage globalVariable baseLocale

# If generated files seem stale, delete and recompile:
rm -rf src/lib/paraglide && npm run paraglide:compile
```

**How it works internally:**
- Each message key becomes a separate `.js` file (e.g. `feed_noLocations` → `feed_nolocations1.js`)
- All are re-exported from `messages/_index.js` with original casing via string alias exports
- `svelte-check` will fail with "Property does not exist" errors if paraglide wasn't recompiled after adding keys

**COMMON BUG — keys added to `en.json` but not other language files:**
Paraglide compiles successfully even if non-English files are missing keys (it falls back to English at runtime). But `svelte-check` validates against the generated TypeScript types from `en.json`. If you add a key to `en.json`, compile, and use it in a component — it works locally. But if the CI runs `npm run check` on a branch where the key was never added to `en.json` in the first place (e.g. keys referenced in code but never committed to message files), lint fails. **Always grep your `.svelte` files for new `m.*()` calls and confirm every key exists in all 12 message files before committing.**

## Pre-Commit Checklist

Before committing frontend changes, run:

```bash
cd frontend
npm run paraglide:compile   # Regenerate from message files
npm run check               # svelte-check (catches missing keys, type errors)
npm test                    # Vitest (unit tests)
```

If `npm run check` fails with "Property does not exist on type 'typeof messages'", a `m.*()` key is missing from `messages/en.json`. Add it to all 12 language files, recompile, and re-run.

## Build

```bash
npm run build  # Outputs to /build (static files)
```

Static files are copied into the FastAPI Docker image at `backend/app/frontend_client/`.

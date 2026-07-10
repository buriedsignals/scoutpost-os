# Frontend Tests

## Project-Wide Rules

Read the nearest parent `AGENTS.md` / `AGENTS.md` before editing; its session preflight points to the canonical coding-rules skill. This file only adds directory-specific context.

## Running Tests

```bash
cd frontend

# All tests
npm test

# Watch mode
npm run test:watch

# Single file
npx vitest run src/tests/utils/scouts.test.ts
```

## Structure

```
src/tests/
├── setup.ts                   # Global setup (jest-dom matchers)
├── api-client.test.ts         # API client contract tests
├── utils/
│   └── scouts.test.ts         # Scout/shared utility logic
└── mocks/
    ├── app-environment.ts     # Mock $app/environment
    ├── app-stores.ts          # Mock $app/stores
    └── env-dynamic-public.ts  # Mock $env/dynamic/public
```

## Testing Strategy

Prefer testing **logic pipelines** over Svelte component rendering:

1. **Pure utility functions** (`$lib/utils/`) — extracted from Svelte components, tested directly
2. **API client contract** (`$lib/api-client.ts`) — mocked `fetch`, verifies URLs, methods, bodies, auth headers, error handling

Extract logic into a `$lib/utils/<name>.ts` and test it directly whenever the
behavior can be isolated from the DOM — it is faster and less brittle.

**Component rendering IS used where behavior is inseparable from the markup.**
A few suites render a component with `@testing-library/svelte` (e.g.
`components/archive-toggle.test.ts` renders `ScoutScheduleModal` to prove the
entitlement gate disables the toggle for free SaaS users; `callback-events` and
`setup-page` do likewise). This works despite the historical Paraglide
barrel-export friction. When you render a component that reads
`import.meta.env.PUBLIC_*`, stub it explicitly with `vi.stubEnv(...)` — vitest
does not apply the `PUBLIC_`/`VITE_` env prefix, so an unstubbed `PUBLIC_*` var
reads as `undefined` and can silently pass a gate you meant to assert. Reach for
rendering only when a pure-function extraction genuinely can't capture the
behavior; visual/layout appearance is still verified manually.

## Utility Modules

Logic extracted from Svelte components into testable `.ts` files:

| Module | Source Component | Functions |
|--------|-----------------|-----------|
| `$lib/utils/scouts.ts` | workspace and scheduling UI | `SCOUT_COSTS`, `formatRegularity`, `truncateUrl`, `stripMarkdown`, `getCriteriaStatusVariant` |

## Mock Strategy

### API Client Tests

- Mock `$lib/stores/auth` — `authStore.getToken` returns test token
- Mock `$lib/config/api` — `buildApiUrl` returns predictable paths
- `vi.stubGlobal('fetch', ...)` — control response bodies and status codes

### SvelteKit Module Aliases (vitest.config.ts)

| Alias | Mock File | Purpose |
|-------|-----------|---------|
| `$lib` | `src/lib` | Standard SvelteKit alias |
| `$app/environment` | `mocks/app-environment.ts` | `browser = true` |
| `$app/stores` | `mocks/app-stores.ts` | Mock `page` store |
| `$env/dynamic/public` | `mocks/env-dynamic-public.ts` | Empty `PUBLIC_*` vars |

## Adding New Tests

1. Extract logic from `.svelte` into `$lib/utils/<name>.ts`
2. Create test at `src/tests/utils/<name>.test.ts`
3. Import functions directly — no Svelte rendering needed
4. Run `npm test` to verify

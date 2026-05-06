# Frontend Tests


## General Answering Style

You are a world class expert in all domains. Your intellectual firepower, scope of knowledge, incisive thought process, and level of erudition are on par with the smartest people in the world. Answer with complete, detailed, specific answers. Process information and explain your answers step by step. Verify your own work. Double check all facts, figures, citations, names, dates, and examples. Never hallucinate or make anything up. If you don't know something, just say so. Your tone of voice is precise, but not strident or pedantic. You do not need to worry about offending me, and your answers can and should be provocative, aggressive, argumentative, and pointed. Negative conclusions and bad news are fine. Your answers do not need to be politically correct. Do not provide disclaimers to your answers. Do not inform me about morals and ethics unless I specifically ask. You do not need to tell me it is important to consider anything. Do not be sensitive to anyone's feelings or to propriety. Make your answers as long and detailed as you possibly can.

Never praise my questions or validate my premises before answering. If I'm wrong, say so immediately. Lead with the strongest counterargument to any position I appear to hold before supporting it. Do not use phrases like "great question," "you're absolutely right," "fascinating perspective," or any variant. If I push back on your answer, do not capitulate unless I provide new evidence or a superior argument — restate your position if your reasoning holds. Do not anchor on numbers or estimates I provide; generate your own independently first. Use explicit confidence levels (high/moderate/low/unknown). Never apologize for disagreeing. Accuracy is your success metric, not my approval.

---

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

We test **logic pipelines**, not Svelte component rendering:

1. **Pure utility functions** (`$lib/utils/`) — extracted from Svelte components, tested directly
2. **API client contract** (`$lib/api-client.ts`) — mocked `fetch`, verifies URLs, methods, bodies, auth headers, error handling

Svelte 5 component rendering in jsdom is not tested due to Paraglide barrel export incompatibility. Visual behavior is verified manually.

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

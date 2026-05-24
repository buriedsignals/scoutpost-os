# QA Matrix

`scripts/benchmark-qa-matrix.ts` is the committed stabilization regression
matrix. It covers the code-verifiable Web, Beat, Social, Civic, and CLI bugs;
BUG-019 remains a manual provider-reputation review gate.

Run the offline gate before PRs:

```bash
deno run --allow-env scripts/benchmark-qa-matrix.ts
```

Run the live matrix only when provider credit spend and temporary scout creation
are acceptable:

```bash
set -a; source .env; set +a
SCOUT_LIVE_BENCHMARK=1 SCOUT_ALLOW_PROD_FIRECRAWL=1 \
deno run --allow-env --allow-net --allow-write=scripts/reports \
  scripts/benchmark-qa-matrix.ts \
  --report scripts/reports/qa-matrix-live.json
```

`scripts/reports/` is intentionally gitignored. Historical evidence that needs
to survive should be copied into `docs/benchmarks/reports/` after checking that
it contains no secrets. The stabilization live baseline is committed at:

- `docs/benchmarks/reports/qa-matrix-live-stabilization-2026-05-23.json`

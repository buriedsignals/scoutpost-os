# QA Matrix

`scripts/benchmarks/benchmark-qa-matrix.ts` is the committed stabilization regression
matrix. It covers the code-verifiable Web, Beat, Social, Civic, and CLI bugs;
BUG-019 remains a manual provider-reputation review gate.

Run the offline gate before PRs:

```bash
deno run --allow-env scripts/benchmarks/benchmark-qa-matrix.ts
```

Run the live matrix only when provider credit spend and temporary scout creation
are acceptable:

```bash
set -a; source .env; set +a
SCOUT_LIVE_BENCHMARK=1 SCOUT_ALLOW_PROD_FIRECRAWL=1 \
deno run --allow-env --allow-net --allow-write=scripts/reports \
  scripts/benchmarks/benchmark-qa-matrix.ts \
  --report scripts/reports/qa-matrix-live.json
```

`scripts/reports/` is intentionally gitignored. Keep durable conclusions in
the relevant feature or Supabase docs rather than committing generated report
artifacts.

#!/usr/bin/env bash
set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "usage: $0 <benchmark command...>" >&2
  exit 2
fi

if ! command -v supabase >/dev/null 2>&1; then
  echo "supabase CLI is required" >&2
  exit 2
fi
if ! command -v deno >/dev/null 2>&1; then
  echo "deno is required" >&2
  exit 2
fi

projects_json="$(mktemp /tmp/scoutpost-projects.XXXXXX)"
keys_json="$(mktemp /tmp/scoutpost-api-keys.XXXXXX)"
cleanup() {
  rm -f "$projects_json" "$keys_json"
}
trap cleanup EXIT

supabase projects list -o json > "$projects_json"
project_ref="${SCOUT_BENCH_SUPABASE_PROJECT_REF:-}"
if [[ -z "$project_ref" ]]; then
  project_ref="$(deno eval '
    const projects = JSON.parse(Deno.readTextFileSync(Deno.args[0]));
    const linked = projects.find((p) => p.linked);
    if (!linked?.ref) Deno.exit(1);
    console.log(linked.ref);
  ' "$projects_json")"
fi
if [[ -z "$project_ref" ]]; then
  echo "No linked Supabase project found. Set SCOUT_BENCH_SUPABASE_PROJECT_REF." >&2
  exit 2
fi

supabase projects api-keys --project-ref "$project_ref" -o json > "$keys_json"
eval "$(
  deno eval '
    const quote = (value) => {
      if (typeof value !== "string" || value.length === 0) Deno.exit(1);
      return "'"'"'" + value.replaceAll("'"'"'", "'"'"'\\'"'"''"'"'") + "'"'"'";
    };
    const keys = JSON.parse(Deno.readTextFileSync(Deno.args[0]));
    const projectRef = Deno.args[1];
    const byName = (name) => keys.find((key) => key.name === name)?.api_key;
    const anon = byName("anon");
    const service = byName("service_role");
    if (!anon || !service) Deno.exit(1);
    console.log(`export SUPABASE_URL=${quote(`https://${projectRef}.supabase.co`)}`);
    console.log(`export SUPABASE_ANON_KEY=${quote(anon)}`);
    console.log(`export SUPABASE_SERVICE_ROLE_KEY=${quote(service)}`);
    console.log(`export SCOUT_BENCHMARK_TARGET=${quote(Deno.env.get("SCOUT_BENCHMARK_TARGET") ?? "scout-health")}`);
    console.log(`export SCOUT_BENCHMARK_PROJECT=${quote(Deno.env.get("SCOUT_BENCHMARK_PROJECT") ?? "1")}`);
    console.log(`export SCOUT_LIVE_BENCHMARK=${quote(Deno.env.get("SCOUT_LIVE_BENCHMARK") ?? "1")}`);
    console.log(`export SCOUT_ALLOW_PROD_FIRECRAWL=${quote(Deno.env.get("SCOUT_ALLOW_PROD_FIRECRAWL") ?? "1")}`);
  ' "$keys_json" "$project_ref"
)"

echo "Running benchmark against linked Supabase project: $project_ref" >&2
exec "$@"

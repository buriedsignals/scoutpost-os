#!/usr/bin/env -S deno run --allow-env --allow-run --allow-read=. --allow-write=scripts/reports --allow-net
import { assertLiveBenchmarkAllowed } from "./_bench_shared.ts";

interface SuiteResult {
  name: string;
  ok: boolean;
  code: number;
  elapsedMs: number;
}

const target = Deno.env.get("COJO_BENCHMARK_TARGET") ?? "";
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? Deno.env.get("API_URL") ??
  "";
if (target !== "oss") {
  throw new Error("Set COJO_BENCHMARK_TARGET=oss to run live OSS benchmarks.");
}
if (Deno.env.get("COJO_LIVE_BENCHMARK") !== "1") {
  throw new Error(
    "Refusing to run live OSS benchmarks without COJO_LIVE_BENCHMARK=1.",
  );
}
if (
  /cojournalist\.ai/i.test(supabaseUrl) &&
  Deno.env.get("COJO_ALLOW_HOSTED_BENCHMARK") !== "1"
) {
  throw new Error(
    "Refusing to run OSS benchmarks against hosted cojournalist.ai.",
  );
}
if (!supabaseUrl) throw new Error("Missing SUPABASE_URL or API_URL.");
assertLiveBenchmarkAllowed(supabaseUrl, { firecrawl: true });

const scripts = [
  ["page", "scripts/benchmark-web.ts"],
  ["page-subpage", "scripts/benchmark-subpage-follow.ts"],
  ["beat", "scripts/benchmark-beat.ts"],
  ["civic", "scripts/benchmark-civic.ts"],
  ["social", "scripts/benchmark-social.ts"],
  ["apify-actors", "scripts/benchmark-apify-actors.ts"],
] as const;

const results: SuiteResult[] = [];
for (const [name, script] of scripts) {
  const started = performance.now();
  console.log(`\n== ${name} ==`);
  const output = await new Deno.Command("deno", {
    args: [
      "run",
      "--allow-env",
      "--allow-net",
      "--allow-read=.",
      "--allow-write=scripts/reports",
      script,
    ],
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  results.push({
    name,
    ok: output.success,
    code: output.code,
    elapsedMs: Math.round(performance.now() - started),
  });
}

await Deno.mkdir("scripts/reports", { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const reportPath = `scripts/reports/oss-suite-${stamp}.json`;
await Deno.writeTextFile(reportPath, JSON.stringify({ results }, null, 2));
console.log(`\nSuite report: ${reportPath}`);

const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  throw new Error(
    `OSS benchmark suite failed: ${failed.map((r) => r.name).join(", ")}`,
  );
}

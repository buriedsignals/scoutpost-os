#!/usr/bin/env -S deno run --allow-env --allow-net --allow-write=scripts/reports
import {
  buildSocialActorInput,
  normalizeSocialDatasetPosts,
  SOCIAL_APIFY_ACTORS,
} from "../supabase/functions/_shared/social_baseline.ts";

type Platform = "instagram" | "x" | "facebook" | "tiktok";

interface ActorCase {
  platform: Platform;
  handle: string;
}

interface ActorResult {
  platform: Platform;
  handle: string;
  actorId: string;
  ok: boolean;
  rawCount: number;
  normalizedCount: number;
  firstKeys: string[];
  error: string | null;
  elapsedMs: number;
}

const APIFY_TIMEOUT_SECS = Number(Deno.env.get("APIFY_TIMEOUT_SECS") ?? "180");
const token = mustEnv("APIFY_API_TOKEN");
const cases: ActorCase[] = [
  {
    platform: "instagram",
    handle: Deno.env.get("COJO_BENCH_INSTAGRAM_HANDLE") ?? "natgeo",
  },
  { platform: "x", handle: Deno.env.get("COJO_BENCH_X_HANDLE") ?? "SadiqKhan" },
  {
    platform: "facebook",
    handle: Deno.env.get("COJO_BENCH_FACEBOOK_HANDLE") ?? "nasa",
  },
  {
    platform: "tiktok",
    handle: Deno.env.get("COJO_BENCH_TIKTOK_HANDLE") ?? "natgeo",
  },
];

const results: ActorResult[] = [];
for (const c of cases) {
  results.push(await runActorCase(c));
}

await writeReports(results);

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  const mark = r.ok ? "OK" : "FAIL";
  console.log(
    `${mark} ${r.platform} actor=${r.actorId} raw=${r.rawCount} normalized=${r.normalizedCount}` +
      (r.error ? ` error=${r.error}` : ""),
  );
}

if (failed.length > 0) {
  throw new Error(
    `Apify actor benchmark failed for: ${
      failed.map((r) => r.platform).join(", ")
    }`,
  );
}

async function runActorCase(c: ActorCase): Promise<ActorResult> {
  const started = performance.now();
  const actor = SOCIAL_APIFY_ACTORS[c.platform];
  try {
    const endpoint =
      `https://api.apify.com/v2/acts/${actor.id}/run-sync-get-dataset-items` +
      `?token=${encodeURIComponent(token)}&timeout=${APIFY_TIMEOUT_SECS}`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildSocialActorInput(c.platform, c.handle)),
      signal: AbortSignal.timeout((APIFY_TIMEOUT_SECS + 20) * 1000),
    });
    if (!res.ok) {
      throw new Error(`${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const raw = await res.json().catch(() => []);
    const rawRows = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const normalized = normalizeSocialDatasetPosts(c.platform, raw);
    const firstKeys = rawRows[0] && typeof rawRows[0] === "object"
      ? Object.keys(rawRows[0] as Record<string, unknown>).slice(0, 30)
      : [];
    const placeholderOnly = rawRows.length > 0 && normalized.length === 0 &&
      rawRows.every((row) =>
        row && typeof row === "object" &&
        (row as Record<string, unknown>).noResults === true
      );
    const missingUsableShape = normalized.length === 0 ||
      normalized.every((post) => !post.text && !post.imageUrl);
    const error = placeholderOnly
      ? "actor returned only noResults placeholders"
      : missingUsableShape
      ? "no normalized posts with text or media"
      : null;
    return {
      platform: c.platform,
      handle: c.handle,
      actorId: actor.id,
      ok: !error,
      rawCount: rawRows.length,
      normalizedCount: normalized.length,
      firstKeys,
      error,
      elapsedMs: Math.round(performance.now() - started),
    };
  } catch (e) {
    return {
      platform: c.platform,
      handle: c.handle,
      actorId: actor.id,
      ok: false,
      rawCount: 0,
      normalizedCount: 0,
      firstKeys: [],
      error: e instanceof Error ? e.message : String(e),
      elapsedMs: Math.round(performance.now() - started),
    };
  }
}

async function writeReports(results: ActorResult[]) {
  await Deno.mkdir("scripts/reports", { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = `scripts/reports/apify-actors-${stamp}.json`;
  const mdPath = `scripts/reports/apify-actors-${stamp}.md`;
  await Deno.writeTextFile(jsonPath, JSON.stringify({ results }, null, 2));
  await Deno.writeTextFile(
    mdPath,
    [
      "# Apify Actor Benchmark",
      "",
      "| Platform | Actor | Handle | OK | Raw | Normalized | Error |",
      "|---|---|---:|---:|---:|---:|---|",
      ...results.map((r) =>
        `| ${r.platform} | \`${r.actorId}\` | ${r.handle} | ${r.ok} | ${r.rawCount} | ${r.normalizedCount} | ${
          r.error ?? ""
        } |`
      ),
      "",
    ].join("\n"),
  );
  console.log(`Reports: ${jsonPath}, ${mdPath}`);
}

function mustEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

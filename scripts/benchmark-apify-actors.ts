#!/usr/bin/env -S deno run --allow-env --allow-net --allow-write=scripts/reports
import {
  BenchCtx,
  envAny,
  getBenchCtx,
  jsonOrThrow,
  userFetch,
} from "./_bench_shared.ts";
import { SOCIAL_APIFY_ACTORS } from "../supabase/functions/_shared/social_baseline.ts";

type Platform = "instagram" | "x" | "facebook" | "tiktok";

interface ActorCase {
  platform: Platform;
  handle: string;
}

interface SocialTestResponse {
  valid?: boolean;
  profile_url?: string;
  error?: string;
  post_ids?: string[];
  preview_posts?: unknown[];
  posts_data?: unknown[];
}

interface ActorResult {
  platform: Platform;
  handle: string;
  actorId: string;
  ok: boolean;
  profileUrl: string | null;
  postIds: number;
  previewPosts: number;
  postsData: number;
  error: string | null;
  elapsedMs: number;
}

const cases: ActorCase[] = [
  {
    platform: "instagram",
    handle:
      envAny("SCOUT_BENCH_INSTAGRAM_HANDLE", "COJO_BENCH_INSTAGRAM_HANDLE") ??
        "natgeo",
  },
  {
    platform: "x",
    handle: envAny("SCOUT_BENCH_X_HANDLE", "COJO_BENCH_X_HANDLE") ??
      "SadiqKhan",
  },
  {
    platform: "facebook",
    handle:
      envAny("SCOUT_BENCH_FACEBOOK_HANDLE", "COJO_BENCH_FACEBOOK_HANDLE") ??
        "nasa",
  },
  {
    platform: "tiktok",
    handle: envAny("SCOUT_BENCH_TIKTOK_HANDLE", "COJO_BENCH_TIKTOK_HANDLE") ??
      "natgeo",
  },
];

const ctx = await getBenchCtx({ userToken: true });
const results: ActorResult[] = [];
for (const c of cases) {
  results.push(await runActorCase(ctx, c));
}

await writeReports(results);

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  const mark = r.ok ? "OK" : "FAIL";
  console.log(
    `${mark} ${r.platform} actor=${r.actorId} posts=${r.postIds} preview=${r.previewPosts}` +
      (r.error ? ` error=${r.error}` : ""),
  );
}

if (failed.length > 0) {
  throw new Error(
    `Supabase social-test actor benchmark failed for: ${
      failed.map((r) => r.platform).join(", ")
    }`,
  );
}

async function runActorCase(
  ctx: BenchCtx,
  c: ActorCase,
): Promise<ActorResult> {
  const started = performance.now();
  const actor = SOCIAL_APIFY_ACTORS[c.platform];
  try {
    const res = await userFetch(ctx, "/social-test", {
      body: { platform: c.platform, handle: c.handle },
    });
    const body = await jsonOrThrow<SocialTestResponse>(
      res,
      `social-test ${c.platform}`,
    );
    const postIds = Array.isArray(body.post_ids) ? body.post_ids.length : 0;
    const previewPosts = Array.isArray(body.preview_posts)
      ? body.preview_posts.length
      : 0;
    const postsData = Array.isArray(body.posts_data)
      ? body.posts_data.length
      : 0;
    const error = body.valid !== true
      ? body.error ?? "profile validation failed"
      : postIds === 0 || previewPosts === 0 || postsData === 0
      ? body.error ?? "social-test returned no normalized preview posts"
      : null;
    return {
      platform: c.platform,
      handle: c.handle,
      actorId: actor.id,
      ok: !error,
      profileUrl: body.profile_url ?? null,
      postIds,
      previewPosts,
      postsData,
      error,
      elapsedMs: Math.round(performance.now() - started),
    };
  } catch (e) {
    return {
      platform: c.platform,
      handle: c.handle,
      actorId: actor.id,
      ok: false,
      profileUrl: null,
      postIds: 0,
      previewPosts: 0,
      postsData: 0,
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
      "# Supabase Social Actor Benchmark",
      "",
      "| Platform | Actor | Handle | OK | Posts | Preview | Data | Profile | Error |",
      "|---|---|---:|---:|---:|---:|---:|---|---|",
      ...results.map((r) =>
        `| ${r.platform} | \`${r.actorId}\` | ${r.handle} | ${r.ok} | ${r.postIds} | ${r.previewPosts} | ${r.postsData} | ${
          r.profileUrl ?? ""
        } | ${r.error ?? ""} |`
      ),
      "",
    ].join("\n"),
  );
  console.log(`Reports: ${jsonPath}, ${mdPath}`);
}

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type BeatAbHit,
  logBeatAbRun,
  summarizeBeatAbRun,
} from "./beat_ab_logger.ts";

const rawHits: BeatAbHit[] = [
  {
    url: "https://example.ch/news/zurich-budget",
    title: "Zurich council approves budget",
    description: "City of Zurich local budget update",
    date: "2026-05-20T00:00:00Z",
  },
  {
    url: "https://example.com/story",
    title: "Regional item",
    description: "No publish date here",
    date: null,
  },
];

Deno.test("summarizeBeatAbRun computes deterministic retrieval metrics", () => {
  const summary = summarizeBeatAbRun({
    rawHits,
    finalHits: [rawHits[0]],
    location: { city: "Zurich", country: "Switzerland", countryCode: "CH" },
  });
  assertEquals(summary, {
    rawHitCount: 2,
    datedHitCount: 1,
    finalHitCount: 1,
    localityScore: 1,
    freshnessScore: 0.5,
  });
});

Deno.test("summarizeBeatAbRun does not treat two-letter country codes as raw substrings", () => {
  const summary = summarizeBeatAbRun({
    rawHits: [],
    finalHits: [
      {
        url: "https://example.com/school-board",
        title: "School board chair discusses childcare",
        description: "This text contains many ch substrings but is not Swiss.",
        date: null,
      },
      {
        url: "https://example.ch/news/local",
        title: "Local item",
        description: "Domain TLD should count for CH.",
        date: null,
      },
    ],
    location: { countryCode: "CH" },
  });

  assertEquals(summary.localityScore, 0.5);
});

Deno.test("summarizeBeatAbRun matches city and country as terms, not substrings", () => {
  const summary = summarizeBeatAbRun({
    rawHits: [],
    finalHits: [
      {
        url: "https://example.com/story",
        title: "Housing reform in Zurich",
        description: "Local planning debate",
        date: null,
      },
      {
        url: "https://example.com/search",
        title: "A confusing zurcher typo",
        description: "Not the configured city.",
        date: null,
      },
    ],
    location: { city: "Zurich" },
  });

  assertEquals(summary.localityScore, 0.5);
});

Deno.test("logBeatAbRun inserts one row and returns true", async () => {
  const inserts: Record<string, unknown>[] = [];
  const db = {
    from(table: string) {
      assertEquals(table, "beat_ab_runs");
      return {
        insert(value: Record<string, unknown>) {
          inserts.push(value);
          return { error: null };
        },
      };
    },
  };

  const ok = await logBeatAbRun(db as never, {
    scoutId: "scout-1",
    runId: "run-1",
    userId: "user-1",
    retrieval: "exa",
    rawHits,
    finalHits: [rawHits[0]],
    unitsCreated: 2,
    unitsMerged: 1,
    location: { city: "Zurich", countryCode: "CH" },
    metadata: { scope: "combined" },
  });

  assertEquals(ok, true);
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].retrieval, "exa");
  assertEquals(inserts[0].raw_hit_count, 2);
  assertEquals(inserts[0].dated_hit_count, 1);
  assertEquals(inserts[0].final_hit_count, 1);
  assertEquals(inserts[0].units_created, 2);
  assertEquals(inserts[0].units_merged, 1);
  assertEquals(inserts[0].freshness_score, 0.5);
  assertEquals(inserts[0].metadata, { scope: "combined" });
});

Deno.test("logBeatAbRun is best-effort on insert errors", async () => {
  const db = {
    from() {
      return {
        insert() {
          return { error: { message: "relation does not exist" } };
        },
      };
    },
  };
  const ok = await logBeatAbRun(db as never, {
    scoutId: "scout-1",
    runId: "run-1",
    userId: "user-1",
    retrieval: "firecrawl",
    rawHits: [],
    finalHits: [],
    unitsCreated: 0,
    unitsMerged: 0,
  });
  assertEquals(ok, false);
});

// promoteScoutFallbackAfterRepeatedExaLowCoverage and its two tests were removed
// with the Exa-only cutover — beat retrieval no longer promotes scouts back to
// Firecrawl, so the function had no remaining callers.


import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  applyEffectiveCandidateUrls,
  candidateUrlValuesDiffer,
  capPageScoutCandidates,
  isInitialChildBaseline,
  pageScoutCandidateKey,
  selectActiveChildCandidates,
  shouldCheckIndexChildren,
  sortCandidatesByLastCheck,
  summarizePageScoutCoverage,
} from "./page_scout_schedule.ts";

Deno.test("active membership retains the validated effective child URL", () => {
  const current = ["https://example.test/news/item"];
  const canonical = applyEffectiveCandidateUrls(
    current,
    [{
      requested: "https://example.test/news/item",
      effective: "https://www.example.test/news/item/",
    }],
    pageScoutCandidateKey,
  );
  assertEquals(canonical, ["https://www.example.test/news/item/"]);
  assertEquals(candidateUrlValuesDiffer(current, canonical), true);
});

Deno.test("redirect aliases do not evict distinct children at the 500-candidate cap", () => {
  const discovered = Array.from(
    { length: 500 },
    (_, index) => `https://example.test/news/item-${index}`,
  );
  const knownSuccessful = discovered.map((url) =>
    url.replace("https://example.test", "https://www.example.test") + "/"
  );
  const selected = capPageScoutCandidates(
    [
      ...new Map(
        selectActiveChildCandidates({
          discovered,
          knownSuccessful,
          rootChanged: false,
        }).map((url) => [pageScoutCandidateKey(url), url]),
      ).values(),
    ],
  );
  assertEquals(selected.length, 500);
  assertEquals(new Set(selected.map(pageScoutCandidateKey)).size, 500);
  assertEquals(
    selected.every((url) => new URL(url).hostname.startsWith("www.")),
    true,
  );
});

Deno.test("initial membership and rotation share the same 500-candidate universe", () => {
  const discovered = Array.from(
    { length: 500 },
    (_, index) => `fresh-${index}`,
  );
  const selected = capPageScoutCandidates(selectActiveChildCandidates({
    discovered,
    knownSuccessful: ["known-child"],
    rootChanged: false,
  }));
  assertEquals(selected.length, 500);
  assertEquals(selected.includes("known-child"), true);
});

Deno.test("sortCandidatesByLastCheck rotates never-seen then oldest children", () => {
  const normalized = (url: string) => url.toLowerCase();
  const last = new Map([
    ["https://example.test/news/a", 300],
    ["https://example.test/news/b", 100],
    ["https://example.test/news/c", 200],
  ]);
  assertEquals(
    sortCandidatesByLastCheck(
      [
        "https://example.test/news/a",
        "https://example.test/news/d",
        "https://example.test/news/c",
        "https://example.test/news/b",
      ],
      last,
      new Map(),
      normalized,
    ),
    [
      "https://example.test/news/d",
      "https://example.test/news/b",
      "https://example.test/news/c",
      "https://example.test/news/a",
    ],
  );
});

Deno.test("PS-COVERAGE-001 partial or failed child coverage is never reported complete", () => {
  assertEquals(
    summarizePageScoutCoverage({
      childCandidates: 14,
      childrenAttempted: 10,
      childrenScraped: 9,
      childrenFailed: 1,
    }),
    {
      sourcesScraped: 10,
      sourcesFailed: 1,
      coverageComplete: false,
    },
  );
  assertEquals(
    summarizePageScoutCoverage({
      childCandidates: 4,
      childrenAttempted: 4,
      childrenScraped: 4,
      childrenFailed: 0,
    }).coverageComplete,
    true,
  );
});

Deno.test("rotation does not depend on whether a child produced units", () => {
  const normalized = (url: string) => url;
  const last = new Map([
    ["zero-unit-child", 50],
    ["unit-child", 40],
  ]);
  assertEquals(
    sortCandidatesByLastCheck(
      ["zero-unit-child", "unit-child"],
      last,
      new Map(),
      normalized,
    ),
    ["unit-child", "zero-unit-child"],
  );
});

Deno.test("PS-ROTATE-001 failed children rotate while preserving slots for known children", () => {
  const candidates = Array.from(
    { length: 14 },
    (_, index) =>
      `https://example.test/news/${index.toString().padStart(2, "0")}`,
  );
  const firstRun = sortCandidatesByLastCheck(
    candidates,
    new Map(),
    new Map(),
    (url) => url,
  ).slice(0, 10);
  const attempted = new Map(firstRun.map((url) => [url, 100]));
  assertEquals(
    sortCandidatesByLastCheck(
      candidates,
      new Map(),
      attempted,
      (url) => url,
    ).filter((url) => candidates.slice(10).includes(url)),
    candidates.slice(10),
  );
});

Deno.test("continuous new-child churn cannot starve known children", () => {
  const known = Array.from({ length: 10 }, (_, index) => `known-${index}`);
  const fresh = Array.from({ length: 20 }, (_, index) => `fresh-${index}`);
  const captured = new Map(known.map((url, index) => [url, index]));
  const firstTen = sortCandidatesByLastCheck(
    [...fresh, ...known],
    captured,
    new Map(),
    (url) => url,
  ).slice(0, 10);
  assertEquals(firstTen.filter((url) => url.startsWith("known-")).length, 5);
  assertEquals(firstTen.filter((url) => url.startsWith("fresh-")).length, 5);
});

Deno.test("PS-INDEX-002 known children are checked even when the configured index is unchanged", () => {
  assertEquals(
    shouldCheckIndexChildren({
      deterministicListing: false,
      knownChildCount: 1,
      discoveredChildCount: 0,
    }),
    true,
  );
  assertEquals(
    shouldCheckIndexChildren({
      deterministicListing: false,
      knownChildCount: 0,
      discoveredChildCount: 0,
    }),
    false,
  );
});

Deno.test("only children already linked by the prior root are initial baselines", () => {
  const normalize = (url: string) => url.replace(/\/+$/, "");
  const previous = new Set(["https://example.test/news/item-a"]);
  assertEquals(
    isInitialChildBaseline({
      status: "new",
      requestedUrl: "https://example.test/news/item-a/",
      effectiveUrl: "https://example.test/news/item-a/",
      initialRootCandidates: previous,
      normalize,
    }),
    true,
  );
  assertEquals(
    isInitialChildBaseline({
      status: "new",
      requestedUrl: "https://example.test/news/item-b",
      effectiveUrl: "https://example.test/news/item-b",
      initialRootCandidates: previous,
      normalize,
    }),
    false,
  );
});

Deno.test("an HTML-only child absent from persisted initial membership is an addition", () => {
  assertEquals(
    isInitialChildBaseline({
      status: "new",
      requestedUrl: "https://example.test/news/html-only",
      effectiveUrl: "https://example.test/news/html-only",
      initialRootCandidates: new Set(),
      normalize: (url) => url,
    }),
    false,
  );
});

Deno.test("PS-INDEX-003 a deferred post-activation child remains an addition on its first fetch", () => {
  const added = "https://example.test/news/item-new";
  assertEquals(
    isInitialChildBaseline({
      status: "new",
      requestedUrl: added,
      effectiveUrl: added,
      initialRootCandidates: new Set([
        "https://example.test/news/item-initial",
      ]),
      normalize: (url) => url,
    }),
    false,
  );
});

Deno.test("current membership removes absent children but unchanged discovery failures preserve known children", () => {
  const known = [
    "https://example.test/news/kept",
    "https://example.test/news/removed",
  ];
  assertEquals(
    selectActiveChildCandidates({
      discovered: ["https://example.test/news/kept"],
      knownSuccessful: known,
      rootChanged: true,
    }),
    ["https://example.test/news/kept"],
  );
  assertEquals(
    selectActiveChildCandidates({
      discovered: [],
      knownSuccessful: known,
      rootChanged: false,
    }),
    known,
  );
  assertEquals(
    selectActiveChildCandidates({
      discovered: ["https://example.test/news/kept"],
      knownSuccessful: known,
      rootChanged: false,
    }),
    known,
  );
});

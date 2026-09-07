import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  assertCompleteCivicMembership,
  CIVIC_BASELINE_PARSE_CONCURRENCY,
  CIVIC_DOCUMENT_MEMBERSHIP_MAX,
  CIVIC_REPLACEMENT_CHECK_LIMIT,
  mapCivicBaselineDocuments,
  replacementCheckUrls,
  shouldQueueCivicDocument,
} from "./civic_document_membership.ts";

Deno.test("Civic document membership accepts a complete bounded archive", () => {
  assertEquals(
    assertCompleteCivicMembership(["https://city.example/minutes"]),
    undefined,
  );
});

Deno.test("Civic document membership rejects an archive beyond the complete-baseline cap", () => {
  assertThrows(
    () =>
      assertCompleteCivicMembership(
        Array.from({ length: CIVIC_DOCUMENT_MEMBERSHIP_MAX + 1 }, (_, index) =>
          `https://city.example/minutes/${index}`),
      ),
    Error,
    "membership bound",
  );
});

// The baseline is URL membership: a new URL queues without any parsing; a
// known URL is unchanged unless a hash was computed for it and differs.
Deno.test("Civic document membership queues new URLs and trusts unparsed known URLs", () => {
  const baseline = new Map<string, string | null>([
    ["https://city.example/minutes/a", "a".repeat(64)],
    ["https://city.example/minutes/b", null],
  ]);
  // Unknown URL → queue, no hash needed.
  assertEquals(
    shouldQueueCivicDocument(
      "https://city.example/minutes/c",
      null,
      baseline,
      new Set(),
    ),
    true,
  );
  // Known, not re-hashed this run → assumed unchanged.
  assertEquals(
    shouldQueueCivicDocument(
      "https://city.example/minutes/a",
      null,
      baseline,
      new Set(),
    ),
    false,
  );
  // Known URL-only row, hash computed now → first parse is not a "change".
  assertEquals(
    shouldQueueCivicDocument(
      "https://city.example/minutes/b",
      "b".repeat(64),
      baseline,
      new Set(),
    ),
    false,
  );
  // A 500-document Legistar calendar is within the membership bound.
  assertEquals(
    assertCompleteCivicMembership(
      Array.from(
        { length: 500 },
        (_, i) => `https://seattle.legistar.com/View.ashx?M=A&ID=${i}`,
      ),
    ),
    undefined,
  );
});

Deno.test("replacementCheckUrls picks the newest known documents (hashed or not) up to the limit", () => {
  const docs = [
    "https://city.example/minutes/new",
    "https://city.example/minutes/2026-06",
    "https://city.example/minutes/2026-05",
    "https://city.example/minutes/2026-04",
    "https://city.example/minutes/2026-03",
  ];
  const baseline = new Map<string, string | null>([
    ["https://city.example/minutes/2026-06", "a".repeat(64)],
    ["https://city.example/minutes/2026-05", null],
    ["https://city.example/minutes/2026-04", "c".repeat(64)],
    ["https://city.example/minutes/2026-03", "d".repeat(64)],
  ]);
  assertEquals(CIVIC_REPLACEMENT_CHECK_LIMIT, 3);
  // The new (unknown) URL is queued elsewhere; the newest KNOWN documents are
  // re-hashed, including the URL-only row so its version gets recorded.
  assertEquals(replacementCheckUrls(docs, baseline, 2), [
    "https://city.example/minutes/2026-06",
    "https://city.example/minutes/2026-05",
  ]);
});

Deno.test("Civic document membership ignores reordered unchanged archives", () => {
  const baseline = new Map([
    ["https://city.example/minutes/a", "a".repeat(64)],
    ["https://city.example/minutes/b", "b".repeat(64)],
  ]);
  const reordered = [
    ["https://city.example/minutes/b", "b".repeat(64)],
    ["https://city.example/minutes/a", "a".repeat(64)],
  ] as const;
  for (const [url, hash] of reordered) {
    assertEquals(
      shouldQueueCivicDocument(url, hash, baseline, new Set()),
      false,
    );
  }
});

Deno.test("Civic document membership queues a changed stable URL once", () => {
  const url = "https://city.example/minutes/current";
  const oldHash = "a".repeat(64);
  const newHash = "b".repeat(64);
  assertEquals(
    shouldQueueCivicDocument(
      url,
      newHash,
      new Map([[url, oldHash]]),
      new Set(),
    ),
    true,
  );
  assertEquals(
    shouldQueueCivicDocument(
      url,
      newHash,
      new Map([[url, oldHash]]),
      new Set([url]),
    ),
    false,
  );
});

Deno.test("Civic baseline document work is bounded and preserves URL order", async () => {
  const urls = Array.from(
    { length: CIVIC_BASELINE_PARSE_CONCURRENCY * 2 + 1 },
    (_, index) => `https://city.example/minutes/${index}`,
  );
  let active = 0;
  let peak = 0;
  const results = await mapCivicBaselineDocuments(urls, async (url) => {
    active += 1;
    peak = Math.max(peak, active);
    await Promise.resolve();
    active -= 1;
    return url.split("/").at(-1);
  });

  assertEquals(peak, CIVIC_BASELINE_PARSE_CONCURRENCY);
  assertEquals(results, urls.map((url) => url.split("/").at(-1)));
});

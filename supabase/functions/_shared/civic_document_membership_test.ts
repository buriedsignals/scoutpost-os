import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  assertCompleteCivicMembership,
  CIVIC_BASELINE_PARSE_CONCURRENCY,
  CIVIC_DOCUMENT_MEMBERSHIP_MAX,
  mapCivicBaselineDocuments,
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
    "complete creation baseline limit",
  );
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

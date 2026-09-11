import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import {
  assertCompleteCivicMembership,
  baselineResolvedCivicMeetings,
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

Deno.test("old ModernGov wrapper membership transitions once without historical alerts, later PDFs stay new", async () => {
  const wrapper =
    "https://democracy.leeds.gov.uk/ieListDocuments.aspx?MId=14294&CId=1254";
  const pdf = "https://democracy.leeds.gov.uk/documents/s284748/minutes.pdf";
  const baseline = new Map<string, string | null>([[
    wrapper,
    "old-wrapper-hash",
  ]]);
  const operations: string[] = [];
  const scoped: Array<[string, unknown]> = [];
  const db = {
    from: () => ({
      upsert: (
        rows: Array<{ source_url: string }>,
        opts: { ignoreDuplicates: boolean },
      ) => {
        operations.push("insert");
        assertEquals(rows.map((row) => row.source_url), [pdf]);
        assertEquals(opts.ignoreDuplicates, true);
        return Promise.resolve({ error: null });
      },
      delete: () => {
        operations.push("delete");
        const query = {
          eq: (key: string, value: unknown) => {
            scoped.push([key, value]);
            return query;
          },
          in: (_key: string, values: string[]) => {
            assertEquals(values, [wrapper]);
            return Promise.resolve({ error: null });
          },
        };
        return query;
      },
    }),
  } as unknown as Parameters<typeof baselineResolvedCivicMeetings>[0];
  const input = {
    scoutId: "scout",
    userId: "owner",
    baselineHashes: baseline,
    meetings: [{
      url:
        "https://democracy.leeds.gov.uk/ieListDocuments.aspx?CId=1254&MId=14294&Ver=4",
      outcome: "documents_found" as const,
      documentCount: 1,
      documentUrls: [pdf],
    }],
  };
  assertEquals(await baselineResolvedCivicMeetings(db, input), 1);
  assertEquals(operations, ["insert", "delete"]);
  assertEquals(scoped, [["scout_id", "scout"], ["user_id", "owner"]]);
  assertEquals(shouldQueueCivicDocument(pdf, null, baseline, new Set()), false);
  assertEquals(await baselineResolvedCivicMeetings(db, input), 0);
  assertEquals(
    shouldQueueCivicDocument(pdf + "?revision=2", null, baseline, new Set()),
    true,
  );
});

Deno.test("failed child-membership insertion does not retire the wrapper or change in-memory baseline", async () => {
  const wrapper = "https://democracy.leeds.gov.uk/ieListDocuments.aspx?MId=1";
  const baseline = new Map<string, string | null>([[wrapper, null]]);
  let deleted = false;
  const db = {
    from: () => ({
      upsert: () => Promise.resolve({ error: { message: "write failed" } }),
      delete: () => {
        deleted = true;
      },
    }),
  } as unknown as Parameters<typeof baselineResolvedCivicMeetings>[0];
  await assertRejects(
    () =>
      baselineResolvedCivicMeetings(db, {
        scoutId: "scout",
        userId: "owner",
        baselineHashes: baseline,
        meetings: [{
          url: wrapper,
          outcome: "documents_found",
          documentCount: 1,
          documentUrls: ["https://democracy.leeds.gov.uk/minutes.pdf"],
        }],
      }),
    Error,
    "membership write failed",
  );
  assertEquals(deleted, false);
  assertEquals([...baseline], [[wrapper, null]]);
});

Deno.test("empty historical wrapper retires so newly published minutes can queue later", async () => {
  const wrapper = "https://democracy.leeds.gov.uk/ieListDocuments.aspx?MId=1";
  const baseline = new Map<string, string | null>([[wrapper, null]]);
  const query = { eq: () => query, in: () => Promise.resolve({ error: null }) };
  const db = { from: () => ({ delete: () => query }) } as unknown as Parameters<
    typeof baselineResolvedCivicMeetings
  >[0];
  assertEquals(
    await baselineResolvedCivicMeetings(db, {
      scoutId: "scout",
      userId: "owner",
      baselineHashes: baseline,
      meetings: [{
        url: wrapper,
        outcome: "no_documents",
        documentCount: 0,
        documentUrls: [],
      }],
    }),
    1,
  );
  assertEquals(
    shouldQueueCivicDocument(
      "https://democracy.leeds.gov.uk/documents/new-minutes.pdf",
      null,
      baseline,
      new Set(),
    ),
    true,
  );
});

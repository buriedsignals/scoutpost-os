import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { civicPreviewProbe, previewCivicTrackedUrls } from "./civic_preview.ts";

Deno.test("preview preserves failed wrapper discovery without misreporting a parsed document", async () => {
  const originalFetch = globalThis.fetch;
  const env = {
    SCRAPE_PROVIDER: "crawl4ai",
    SCRAPE_SERVICE_URL: "https://scrape.internal",
    SCRAPE_SERVICE_TOKEN: "test",
  };
  const previous = new Map(
    Object.keys(env).map((key) => [key, Deno.env.get(key)]),
  );
  const listing =
    "https://democracy.leeds.gov.uk/ieListMeetings.aspx?CommitteeId=1254";
  const wrapper = "https://democracy.leeds.gov.uk/ieListDocuments.aspx?MId=1";
  try {
    for (const [key, value] of Object.entries(env)) Deno.env.set(key, value);
    globalThis.fetch = ((_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            markdown: "page",
            source_url: body.url,
            rawHtml: body.url === listing
              ? `<a href="${wrapper}">Meeting</a>`
              : "<p>Gone</p>",
            status_code: body.url === listing ? 200 : 404,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }) as typeof fetch;
    const preview = await previewCivicTrackedUrls([listing]);
    assertEquals(preview.documentsResolved, 0);
    assertEquals(preview.documentsFound, 0);
    const probe = civicPreviewProbe(preview);
    assertEquals(probe.ok, false);
    assertEquals(
      "error_code" in probe ? probe.error_code : null,
      "unreachable",
    );
    assertEquals(preview.discovery?.meetings, [{
      url: wrapper,
      outcome: "fetch_failed",
      documentCount: 0,
      documentUrls: [],
    }]);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
});

Deno.test("preview refuses request-wide overflow before fetching any meeting wrapper", async () => {
  const originalFetch = globalThis.fetch;
  const env = {
    SCRAPE_PROVIDER: "crawl4ai",
    SCRAPE_SERVICE_URL: "https://scrape.internal",
    SCRAPE_SERVICE_TOKEN: "test",
  };
  const previous = new Map(
    Object.keys(env).map((key) => [key, Deno.env.get(key)]),
  );
  let calls = 0;
  try {
    for (const [key, value] of Object.entries(env)) Deno.env.set(key, value);
    globalThis.fetch = ((_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body));
      calls++;
      const committee = Number(
        new URL(body.url).searchParams.get("CommitteeId"),
      );
      if (!committee) {
        throw new Error(
          "preview must not fetch wrappers after detecting overflow",
        );
      }
      return Promise.resolve(
        Response.json({
          markdown: "listing",
          source_url: body.url,
          status_code: 200,
          rawHtml: Array.from(
            { length: 5 },
            (_, i) =>
              `<a href="/ieListDocuments.aspx?MId=${
                committee * 100 + i
              }">Meeting</a>`,
          ).join(""),
        }),
      );
    }) as typeof fetch;
    await assertRejects(
      () =>
        previewCivicTrackedUrls(
          [1, 2].map((committee) =>
            `https://democracy.leeds.gov.uk/ieListMeetings.aspx?CommitteeId=${committee}`
          ),
        ),
      Error,
      "budget exceeded",
    );
    assertEquals(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) {
      value === undefined ? Deno.env.delete(key) : Deno.env.set(key, value);
    }
  }
});

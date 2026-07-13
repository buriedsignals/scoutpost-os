import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import {
  preferSourcePublishedDate,
  publishedDateFromScrape,
  sourcePublishedDate,
} from "./atomic_extract.ts";

Deno.test("preferSourcePublishedDate keeps source metadata over an extracted future date", () => {
  assertEquals(
    preferSourcePublishedDate("2026-07-04", "2030-01-01"),
    "2026-07-04",
  );
  assertEquals(preferSourcePublishedDate(null, "2026-07-04"), "2026-07-04");
});

Deno.test("publishedDateFromScrape uses metadata before markdown", () => {
  assertEquals(
    publishedDateFromScrape({
      metadata: { publishedTime: "2026-04-30T12:00:00Z" },
      markdown: "**April 02, 2026**",
    }),
    "2026-04-30",
  );
});

Deno.test("publishedDateFromScrape falls back to visible markdown date near top", () => {
  assertEquals(
    publishedDateFromScrape({
      metadata: {},
      markdown:
        "# Ontario Introducing Legislation to Strengthen Regional Governance\n\n**April 02, 2026**\n\nBody",
    }),
    "2026-04-02",
  );
});

Deno.test("sourcePublishedDate uses scrape fallback before search date", () => {
  assertEquals(
    sourcePublishedDate({
      scrape: {
        metadata: {},
        markdown: "# Story\n\nApril 02, 2026",
      },
      searchDate: "1 day ago",
    }),
    "2026-04-02",
  );
});

Deno.test("sourcePublishedDate falls back to normalized search date", () => {
  assertEquals(
    sourcePublishedDate({
      scrape: { metadata: {}, markdown: "# Story" },
      searchDate: "2026-04-30T12:00:00Z",
    }),
    "2026-04-30",
  );
});

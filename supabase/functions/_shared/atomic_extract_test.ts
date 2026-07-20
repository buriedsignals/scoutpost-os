import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import {
  classifyExtractionDiagnostics,
  preferSourcePublishedDate,
  publishedDateFromScrape,
  selectExtractionWindow,
  sourcePublishedDate,
} from "./atomic_extract.ts";

Deno.test("classifyExtractionDiagnostics separates empty, filtered, and failed results", () => {
  assertEquals(classifyExtractionDiagnostics(0, 0, 0).outcome, "empty");
  assertEquals(classifyExtractionDiagnostics(2, 2, 0).outcome, "filtered");
  assertEquals(classifyExtractionDiagnostics(2, 2, 1).outcome, "ok");
  assertEquals(
    classifyExtractionDiagnostics(0, 0, 0, "openrouter_503"),
    {
      outcome: "failed",
      raw_units: 0,
      valid_units: 0,
      returned_units: 0,
      error_code: "openrouter_503",
    },
  );
});

Deno.test("selectExtractionWindow centers a late matching article heading", () => {
  const navigation = `EARLIEST_NAV ${
    "Navigation and promotional chrome. ".repeat(100)
  }`;
  const article =
    "# Westminster Council Tax Could Double After Severe Funding Cuts: London 2026\n\n" +
    "Westminster City Council said the funding change could double council tax in 2026. "
      .repeat(40);
  const compressed = `${navigation}\n\n${article}`;

  const window = selectExtractionWindow(
    compressed,
    "Westminster Council Tax Could Double After Severe Funding Cuts: London 2026 | Extra London",
    3000,
    true,
  );

  assertStringIncludes(window, "# Westminster Council Tax Could Double");
  assertStringIncludes(window, "Westminster City Council said");
  assertEquals(window.includes("EARLIEST_NAV"), false);
});

Deno.test("selectExtractionWindow preserves the prefix for weak heading matches", () => {
  const compressed = `${
    "Useful opening context. ".repeat(140)
  }\n\n# Westminster Council Tax\n\nArticle body`;

  assertEquals(
    selectExtractionWindow(
      compressed,
      "Westminster Council Tax Could Double After Severe Funding Cuts: London 2026",
      3000,
      true,
    ),
    compressed.slice(0, 3000),
  );
});

Deno.test("selectExtractionWindow skips an early duplicate and anchors the late article", () => {
  const title = "London Borough Revamps Security Network With Edge AI";
  const compressed = `# ${title}\n\nEARLY_CARD\n\n${
    "Navigation chrome. ".repeat(180)
  }\n\n# ${title}\n\nLATE_FACT The borough approved the system in July 2026.`;

  const window = selectExtractionWindow(compressed, title, 3000, true);

  assertStringIncludes(window, "LATE_FACT");
  assertEquals(window.includes("EARLY_CARD"), false);
});

Deno.test("selectExtractionWindow anchors an exact short title", () => {
  const compressed = `${
    "Navigation chrome. ".repeat(180)
  }\n\n# London rents soar\n\nLATE_FACT Average rents rose in July 2026.`;

  assertStringIncludes(
    selectExtractionWindow(compressed, "London rents soar", 3000, true),
    "LATE_FACT",
  );
});

Deno.test("selectExtractionWindow preserves the prefix for an early matching heading", () => {
  const compressed =
    `Intro\n\n# London Borough Revamps Security Network With Edge AI\n\n${
      "The London borough approved a new security system in July 2026. ".repeat(
        80,
      )
    }`;

  assertEquals(
    selectExtractionWindow(
      compressed,
      "London Borough Revamps Security Network With Edge AI",
      3000,
      true,
    ),
    compressed.slice(0, 3000),
  );
});

Deno.test("selectExtractionWindow preserves the prefix when anchoring is disabled", () => {
  const compressed = `${
    "Page introduction. ".repeat(180)
  }\n\n# London Housing Update\n\nArticle body`;

  assertEquals(
    selectExtractionWindow(
      compressed,
      "London Housing Update",
      3000,
      false,
    ),
    compressed.slice(0, 3000),
  );
});

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

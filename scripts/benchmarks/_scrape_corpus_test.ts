import { assertEquals } from "jsr:@std/assert@1";
import { scoreScrapeProbes, SCRAPE_CORPUS_CASES } from "./_scrape_corpus.ts";

Deno.test("maintained scrape corpus has eight unique live cases", () => {
  assertEquals(SCRAPE_CORPUS_CASES.length, 8);
  assertEquals(new Set(SCRAPE_CORPUS_CASES.map((item) => item.id)).size, 8);
  for (const item of SCRAPE_CORPUS_CASES) {
    assertEquals(new URL(item.url).protocol, "https:");
  }
});

Deno.test("scrape probes score content and length by weight", () => {
  const result = scoreScrapeProbes("OpenAI UK LTD\n12345", [
    { kind: "contains", value: "openai uk ltd", weight: 2 },
    { kind: "contains", value: "missing", weight: 3 },
    { kind: "min_chars", value: "10", weight: 1 },
  ]);
  assertEquals(result, {
    matched: 3,
    possible: 6,
    missed: ["contains:missing"],
  });
});

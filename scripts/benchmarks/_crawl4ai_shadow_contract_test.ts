import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  compareShadowContract,
  ShadowContractValue,
} from "./_crawl4ai_shadow_contract.ts";

const CONTROL: ShadowContractValue = {
  title: "Council sessions",
  rawHtml: "<main>sessions</main>",
  metadata: { title: "Council sessions", language: "en" },
  requested_url: "https://example.com/council",
  source_url: "https://example.com/council",
  status_code: 200,
};

Deno.test("shadow contract permits additive candidate metadata", () => {
  const comparison = compareShadowContract(CONTROL, {
    ...CONTROL,
    metadata: { ...CONTROL.metadata, description: "Public meetings" },
  });
  assert(comparison.passed);
  assertEquals(comparison.missing_metadata_keys, []);
});

Deno.test("shadow contract fails candidate field regressions", () => {
  const comparison = compareShadowContract(CONTROL, {
    ...CONTROL,
    title: null,
    rawHtml: null,
    metadata: { title: "Council sessions" },
    source_url: "https://example.com/error",
    status_code: 500,
  });
  assert(!comparison.passed);
  assert(!comparison.title_retained);
  assert(!comparison.raw_html_retained);
  assert(!comparison.source_url_equal);
  assert(!comparison.status_code_equal);
  assertEquals(comparison.missing_metadata_keys, ["language"]);
});

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  findExactSourceExpression,
  segmentSourceExpressionContent,
} from "./source_expressions.ts";

Deno.test("exact source expression uses UTF-8 byte offsets and line numbers", async () => {
  const content = "Heading\nCafé evidence\nTail";
  const found = await findExactSourceExpression(content, "Café evidence");
  if (!found.ok) throw new Error(found.reason);
  assertEquals(found.anchor.startByte, 8);
  assertEquals(found.anchor.endByte, 22);
  assertEquals(found.anchor.startLine, 2);
  assertEquals(found.anchor.endLine, 2);
  assertEquals(found.anchor.exactText, "Café evidence");
  assertEquals(found.anchor.capturePayloadSha256.length, 64);
});

Deno.test("exact source expression rejects generated or ambiguous quotations", async () => {
  assertEquals((await findExactSourceExpression("one", "two")).ok, false);
  const duplicate = await findExactSourceExpression("same same", "same");
  assertEquals(duplicate, { ok: false, reason: "ambiguous_quote" });
});

Deno.test("deterministic windows preserve all source bytes without splitting lines", () => {
  const content = "α\nsecond line\nthird line\n";
  const windows = segmentSourceExpressionContent(content, 13);
  assertEquals(windows.map((window) => window.text).join(""), content);
  assertEquals(windows[0].startByte, 0);
  assertEquals(
    windows.at(-1)?.endByte,
    new TextEncoder().encode(content).byteLength,
  );
  assertEquals(windows.map((window) => window.startLine), [1, 2, 3]);
});

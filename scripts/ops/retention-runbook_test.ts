import {
  assertEquals,
  assertMatch,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

function sqlFenceAfter(markdown: string, marker: string): string {
  const markerIndex = markdown.indexOf(marker);
  if (markerIndex < 0) return "";
  const fenceStart = markdown.indexOf("```sql\n", markerIndex);
  if (fenceStart < 0) return "";
  const contentStart = fenceStart + "```sql\n".length;
  const fenceEnd = markdown.indexOf("\n```", contentStart);
  return fenceEnd < 0 ? "" : markdown.slice(contentStart, fenceEnd);
}

function unmatchedParenthesisLines(sql: string): number[] {
  const openLines: number[] = [];
  let line = 1;
  let inString = false;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    if (char === "\n") line += 1;
    if (char === "'" && inString && sql[index + 1] === "'") {
      index += 1;
      continue;
    }
    if (char === "'") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "(") openLines.push(line);
    if (char === ")") {
      if (openLines.length === 0) return [-line];
      openLines.pop();
    }
  }
  return openLines;
}

Deno.test("retention monitoring runbook contains balanced executable SQL", async () => {
  const markdown = await Deno.readTextFile(
    new URL("../../docs/supabase/retention.md", import.meta.url),
  );
  const sql = sqlFenceAfter(markdown, "Monitor row counts before/after:");

  assertMatch(sql, /\S/);
  assertMatch(sql, /;\s*$/);
  assertEquals(unmatchedParenthesisLines(sql), []);
});

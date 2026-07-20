import { assertEquals } from "jsr:@std/assert@1";
import { summarizeOutstandingCivicRows } from "./benchmark-civic.ts";

Deno.test("civic benchmark reports the exact non-terminal queue lease", () => {
  assertEquals(
    summarizeOutstandingCivicRows([
      {
        id: "done-id",
        status: "done",
        attempts: 1,
        updated_at: "2026-07-20T09:40:00Z",
        last_error: null,
      },
      {
        id: "stuck-id",
        status: "processing",
        attempts: 2,
        updated_at: "2026-07-20T09:41:00Z",
        last_error: "provider timeout",
      },
    ]),
    [
      "stuck-id:processing:attempts=2:updated=2026-07-20T09:41:00Z:error=provider timeout",
    ],
  );
});

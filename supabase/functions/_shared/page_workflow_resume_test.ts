import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assertRejects } from "https://deno.land/std@0.224.0/assert/assert_rejects.ts";
import { childStage } from "./page_workflow_transport.ts";
import { resumePageRuns } from "./page_workflow_resume.ts";

Deno.test("child stage canonicalizes fragments and trailing slashes", () => {
  assertEquals(
    childStage("https://example.com/story/#section"),
    "child:https://example.com/story",
  );
});

Deno.test("Page resume sends only opaque run and Scout ids", async () => {
  const priorUrl = Deno.env.get("SUPABASE_URL");
  const priorKey = Deno.env.get("INTERNAL_SERVICE_KEY");
  Deno.env.set("SUPABASE_URL", "https://project.supabase.co");
  Deno.env.set("INTERNAL_SERVICE_KEY", "test-internal-key");
  let captured:
    | { url: string; body: unknown; serviceKey: string | null }
    | null = null;
  try {
    await resumePageRuns(
      [{ runId: "run-1", scoutId: "scout-1" }],
      async (input, init) => {
        const request = new Request(input, init);
        captured = {
          url: String(input),
          body: await request.json(),
          serviceKey: request.headers.get("X-Service-Key"),
        };
        return new Response(null, { status: 202 });
      },
    );
    assertEquals(captured, {
      url: "https://project.supabase.co/functions/v1/scout-web-execute",
      body: { scout_id: "scout-1", run_id: "run-1" },
      serviceKey: "test-internal-key",
    });
  } finally {
    if (priorUrl === undefined) Deno.env.delete("SUPABASE_URL");
    else Deno.env.set("SUPABASE_URL", priorUrl);
    if (priorKey === undefined) Deno.env.delete("INTERNAL_SERVICE_KEY");
    else Deno.env.set("INTERNAL_SERVICE_KEY", priorKey);
  }
});

Deno.test("Page resume fails closed without a Supabase URL", async () => {
  const priorUrl = Deno.env.get("SUPABASE_URL");
  Deno.env.delete("SUPABASE_URL");
  try {
    await assertRejects(
      () => resumePageRuns([{ runId: "run-1", scoutId: "scout-1" }]),
      Error,
      "SUPABASE_URL is required",
    );
  } finally {
    if (priorUrl !== undefined) Deno.env.set("SUPABASE_URL", priorUrl);
  }
});

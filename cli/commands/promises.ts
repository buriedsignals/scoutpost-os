// scout promises — read and update human-assessed Civic promise status.
import { apiFetch, parseArgs, printJSON } from "../lib/client.ts";

export async function run(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(
      "Usage: scout promises show <id> | status <id> --to in_progress|fulfilled|broken --expected-updated-at <ISO> [--reason <text>] [--evidence-url <url>] [--idempotency-key <key>",
    );
    if (!sub) Deno.exit(1);
    return;
  }
  const { positional, flags } = parseArgs(rest);
  const id = positional[0];
  if (!id) {
    console.error("promise id is required");
    Deno.exit(1);
  }
  if (sub === "show") {
    printJSON(await apiFetch(`/functions/v1/promises/${id}`));
    return;
  }
  if (sub === "status") {
    if (
      typeof flags.to !== "string" ||
      !["in_progress", "fulfilled", "broken"].includes(flags.to)
    ) {
      console.error("--to must be in_progress, fulfilled, or broken");
      Deno.exit(1);
    }
    if (typeof flags["expected-updated-at"] !== "string") {
      console.error(
        "--expected-updated-at is required; read the promise first",
      );
      Deno.exit(1);
    }
    const body: Record<string, unknown> = {
      status: flags.to,
      expected_updated_at: flags["expected-updated-at"],
    };
    if (typeof flags.reason === "string") body.reason = flags.reason;
    if (typeof flags["evidence-url"] === "string") {
      body.evidence_url = flags["evidence-url"];
    }
    if (typeof flags["idempotency-key"] === "string") {
      body.idempotency_key = flags["idempotency-key"];
    }
    printJSON(
      await apiFetch(`/functions/v1/promises/${id}/status`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    );
    return;
  }
  console.error(`Unknown subcommand: ${sub}`);
  Deno.exit(1);
}

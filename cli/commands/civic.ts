// scout civic — read-first Civic accountability workflow.
import {
  apiFetch,
  CIVIC_API_TIMEOUT_MS,
  parseArgs,
  printJSON,
} from "../lib/client.ts";

function usage(): void {
  console.log(
    "Usage: scout civic discover --root-domain <domain> | preview --tracked-urls <url,url> [--criteria <text>] | items [--kind promise|decision] [--scout-id <uuid>] [--status <state>] | runs [--scout-id <uuid>]",
  );
}

export async function run(argv: string[]): Promise<void> {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    usage();
    if (!subcommand) Deno.exit(1);
    return;
  }
  const { positional, flags } = parseArgs(rest);
  if (subcommand === "discover") {
    if (typeof flags["root-domain"] !== "string") {
      throw new Error("--root-domain is required");
    }
    printJSON(
      await apiFetch("/functions/v1/civic/discover", {
        method: "POST",
        body: JSON.stringify({ root_domain: flags["root-domain"] }),
        timeoutMs: CIVIC_API_TIMEOUT_MS,
      }),
    );
    return;
  }
  if (subcommand === "preview") {
    if (typeof flags["tracked-urls"] !== "string") {
      throw new Error("--tracked-urls is required");
    }
    const body: Record<string, unknown> = {
      tracked_urls: flags["tracked-urls"].split(",").map((url) => url.trim())
        .filter(Boolean),
    };
    if (typeof flags.criteria === "string") body.criteria = flags.criteria;
    printJSON(
      await apiFetch("/functions/v1/civic/test", {
        method: "POST",
        body: JSON.stringify(body),
        timeoutMs: CIVIC_API_TIMEOUT_MS,
      }),
    );
    return;
  }
  if (subcommand === "items" || subcommand === "runs") {
    const params = new URLSearchParams();
    for (
      const key of [
        "kind",
        "scout-id",
        "status",
        "due-before",
        "due-after",
        "limit",
      ]
    ) {
      if (typeof flags[key] === "string") {
        params.set(key.replaceAll("-", "_"), flags[key]);
      }
    }
    const suffix = params.size ? `?${params}` : "";
    printJSON(await apiFetch(`/functions/v1/civic/${subcommand}${suffix}`));
    return;
  }
  if (subcommand === "item" || subcommand === "run") {
    const id = positional[0];
    if (!id) throw new Error(`${subcommand} id is required`);
    printJSON(await apiFetch(`/functions/v1/civic/${subcommand}s/${id}`));
    return;
  }
  usage();
  Deno.exit(1);
}

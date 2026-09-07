// scout civic — read-first Civic accountability workflow.
import {
  apiFetch,
  CIVIC_API_TIMEOUT_MS,
  isTerminal,
  parseArgs,
  printJSON,
} from "../lib/client.ts";
import { printProbeSummary } from "../lib/probe.ts";

function usage(): void {
  console.log(
    [
      "Usage: scout civic <subcommand>",
      "",
      "  resolve  --root-domain <domain>          find pages that list council meetings",
      "  validate --tracked-urls <url,url>        check chosen pages expose meetings",
      "  preview  --tracked-urls <url,url> [--criteria <text>]",
      "                                           sample what a scout would extract",
      "  items    [--kind promise|decision] [--scout-id <uuid>] [--status <state>]",
      "  runs     [--scout-id <uuid>]",
      "",
      "  Two-step flow: resolve (or validate) → preview → scouts add --type civic",
      "  --tracked-urls <chosen>. Only pages with meetings visible are offered; a",
      "  page that exposes none exits 1 with error_code no_meetings_detected.",
      "  `discover` is kept as an alias of `resolve`.",
    ].join("\n"),
  );
}

function trackedUrlsFlag(flags: Record<string, unknown>): string[] {
  if (typeof flags["tracked-urls"] !== "string") {
    throw new Error("--tracked-urls is required");
  }
  return flags["tracked-urls"].split(",").map((url) => url.trim()).filter(
    Boolean,
  );
}

interface ProbeResponse {
  ok?: boolean;
  stage?: string;
  error_code?: string;
  error?: string;
  candidates?: Array<
    {
      url: string;
      description?: string;
      documents_visible?: number;
      recommended?: boolean;
    }
  >;
}

/** Print the JSON (stdout, for agents) and exit 1 when the probe did not pass. */
function finishProbe(result: ProbeResponse): void {
  printJSON(result);
  if (isTerminal()) printProbeSummary(result);
  if (result.ok === false) Deno.exit(1);
}

export async function run(argv: string[]): Promise<void> {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    usage();
    if (!subcommand) Deno.exit(1);
    return;
  }
  const { positional, flags } = parseArgs(rest);
  if (subcommand === "discover" || subcommand === "resolve") {
    if (typeof flags["root-domain"] !== "string") {
      throw new Error("--root-domain is required");
    }
    finishProbe(
      await apiFetch<ProbeResponse>("/functions/v1/civic/discover", {
        method: "POST",
        body: JSON.stringify({ root_domain: flags["root-domain"] }),
        timeoutMs: CIVIC_API_TIMEOUT_MS,
      }),
    );
    return;
  }
  if (subcommand === "validate") {
    finishProbe(
      await apiFetch<ProbeResponse>("/functions/v1/civic/discover", {
        method: "POST",
        body: JSON.stringify({ tracked_urls: trackedUrlsFlag(flags) }),
        timeoutMs: CIVIC_API_TIMEOUT_MS,
      }),
    );
    return;
  }
  if (subcommand === "preview") {
    const body: Record<string, unknown> = {
      tracked_urls: trackedUrlsFlag(flags),
    };
    if (typeof flags.criteria === "string") body.criteria = flags.criteria;
    finishProbe(
      await apiFetch<ProbeResponse>("/functions/v1/civic/test", {
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

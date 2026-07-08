// scout snapshots — evidence-archive snapshot retrieval (PAGE-ARCHIVE-PRD)
//
// Retrieval side of the Page Archive feature. Snapshots exist only for Web/Page
// scouts with archiving enabled (`scout scouts add/update --archive-enabled`).
//   list      → GET  /functions/v1/snapshots
//   download  → POST /functions/v1/snapshots/:id/url  (signed URL) → bytes to disk
//   url       → POST /functions/v1/snapshots/:id/url  (print the signed URL)
import { apiFetch, parseArgs, printJSON, printTable, unwrapItems } from "../lib/client.ts";

/** Artifact kind → file extension for the default download filename. Mirrors
 * the server's ARTIFACTS map (supabase/functions/snapshots/snapshot_view.ts). */
const ARTIFACT_EXT: Record<string, string> = {
  mhtml: "mhtml",
  screenshot: "png",
  rawhtml: "html",
  markdown: "md",
  manifest: "json",
  tsr: "tsr",
};
const ARTIFACT_KINDS = Object.keys(ARTIFACT_EXT);

function usage(): void {
  console.log(
    [
      "Usage: scout snapshots <subcommand>",
      "",
      "  list [--scout <id>] [--offset N] [--limit N] [--json]",
      "  download <id> --artifact <kind> [--out <path>]",
      "  url <id> --artifact <kind>",
      "",
      `  <kind> is one of: ${ARTIFACT_KINDS.join(", ")}`,
      "",
      "Snapshots are captured only for Web/Page scouts with archiving enabled",
      "(scout scouts add/update --archive-enabled true).",
    ].join("\n"),
  );
}

interface Snapshot {
  id: string;
  scout_id?: string;
  capture_kind?: string;
  fidelity?: string;
  served_by?: string | null;
  captured_at?: string;
  requested_url?: string;
  sizes?: Record<string, number | null>;
  trust?: {
    tsa_status?: string | null;
    wayback_status?: string | null;
    wayback_url?: string | null;
  };
  artifacts?: string[];
}

interface SignedUrl {
  url: string;
  artifact: string;
  content_type: string;
  expires_in: number;
}

function toQuery(params: Record<string, string | number | boolean>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : "";
}

function resolveArtifact(flags: Record<string, string | boolean>): string {
  const artifact = typeof flags.artifact === "string" ? flags.artifact : "";
  if (!artifact) {
    console.error("Missing --artifact. One of: " + ARTIFACT_KINDS.join(", "));
    Deno.exit(1);
  }
  if (!ARTIFACT_KINDS.includes(artifact)) {
    console.error(
      `Unknown artifact '${artifact}'. One of: ${ARTIFACT_KINDS.join(", ")}`,
    );
    Deno.exit(1);
  }
  return artifact;
}

async function signUrl(id: string, artifact: string): Promise<SignedUrl> {
  return await apiFetch<SignedUrl>(
    `/functions/v1/snapshots/${id}/url`,
    { method: "POST", body: JSON.stringify({ artifact }) },
  );
}

export async function run(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;

  if (!sub || sub === "--help" || sub === "-h") {
    usage();
    if (!sub) Deno.exit(1);
    return;
  }

  const { positional, flags } = parseArgs(rest);

  switch (sub) {
    case "list": {
      const params: Record<string, string | number | boolean> = {};
      if (typeof flags.scout === "string") params.scout_id = flags.scout;
      if (typeof flags.offset === "string") params.offset = flags.offset;
      if (typeof flags.limit === "string") params.limit = flags.limit;

      const data = await apiFetch<unknown>(
        `/functions/v1/snapshots${toQuery(params)}`,
      );
      const rows = unwrapItems<Snapshot>(data);

      if (flags.json === true) {
        printJSON(rows);
        return;
      }
      printTable(
        rows.map((r) => ({
          id: r.id,
          captured_at: r.captured_at,
          kind: r.capture_kind,
          fidelity: r.fidelity,
          artifacts: (r.artifacts ?? []).join(","),
          tsa: r.trust?.tsa_status ?? "",
          wayback: r.trust?.wayback_status ?? "",
        })) as unknown as Record<string, unknown>[],
        ["id", "captured_at", "kind", "fidelity", "artifacts", "tsa", "wayback"],
      );
      return;
    }

    case "download": {
      const id = positional[0];
      if (!id) {
        console.error("Usage: scout snapshots download <id> --artifact <kind> [--out <path>]");
        Deno.exit(1);
      }
      const artifact = resolveArtifact(flags);
      const signed = await signUrl(id, artifact);
      const dl = await fetch(signed.url);
      if (!dl.ok) {
        throw new Error(`download failed: ${dl.status} ${dl.statusText}`);
      }
      const bytes = new Uint8Array(await dl.arrayBuffer());
      const out = typeof flags.out === "string"
        ? flags.out
        : `snapshot-${id}.${ARTIFACT_EXT[artifact]}`;
      await Deno.writeFile(out, bytes);
      console.log(`Wrote ${bytes.length} bytes to ${out} (${signed.content_type})`);
      return;
    }

    case "url": {
      const id = positional[0];
      if (!id) {
        console.error("Usage: scout snapshots url <id> --artifact <kind>");
        Deno.exit(1);
      }
      const artifact = resolveArtifact(flags);
      const signed = await signUrl(id, artifact);
      console.log(signed.url);
      console.error(
        `# ${signed.artifact} (${signed.content_type}), expires in ${signed.expires_in}s`,
      );
      return;
    }

    default:
      usage();
      Deno.exit(1);
  }
}

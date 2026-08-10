// scout units — information unit management
import { apiFetch, parseArgs, printJSON, printTable } from "../lib/client.ts";

function usage(): void {
  console.log(
    [
      "Usage: scout units <subcommand>",
      "",
      "  list [--project <id>] [--scout <id>] [--verified|--unverified]",
      "       [--used|--unused] [--include-deleted]",
      "       [--offset N] [--limit N]",
      "  show <id>",
      "  evidence <id>",
      "  verify <id> [--notes <text>] [--by <name>]",
      "  reject <id> [--notes <text>]",
      "  mark-used <id> [--url <published-url>]",
      "  delete <id>",
      '  search --query "<text>" [--mode semantic|keyword|hybrid]',
      "         [--project <id>] [--scout <id>] [--verified|--unverified]",
      "         [--used|--unused] [--include-deleted] [--limit N]",
    ].join("\n"),
  );
}

interface Unit {
  id: string;
  statement?: string;
  unit_type?: string;
  source?: { url?: string | null };
  entities?: unknown;
  scout_name?: string | null;
  verification?: {
    verified?: boolean;
    verified_by?: string | null;
    notes?: string | null;
  };
  usage?: {
    used_in_article?: boolean;
    used_at?: string | null;
    used_in_url?: string | null;
  };
  deletion?: {
    deleted?: boolean;
    deleted_at?: string;
    deleted_by?: string;
    reason?: string;
  };
  search_rank?: number | null;
}

function applyStateFlags(
  params: Record<string, string | number | boolean>,
  flags: Record<string, string | boolean>,
): void {
  if (flags.verified === true) params.verified = "true";
  if (flags.unverified === true) params.verified = "false";
  if (flags.used === true) params.used_in_article = "true";
  if (flags.unused === true) params.used_in_article = "false";
  if (flags["include-deleted"] === true) params.include_deleted = "true";
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
      if (typeof flags.project === "string") params.project_id = flags.project;
      if (typeof flags.scout === "string") params.scout_id = flags.scout;
      applyStateFlags(params, flags);
      if (typeof flags.offset === "string") params.offset = flags.offset;
      if (typeof flags.limit === "string") params.limit = flags.limit;

      const data = await apiFetch<Unit[] | { data: Unit[] }>(
        `/functions/v1/units${toQuery(params)}`,
      );
      const rows = Array.isArray(data)
        ? data
        : ((data as { items?: Unit[]; data?: Unit[] }).items ??
          (data as { data?: Unit[] }).data ??
          []);
      printTable(
        rows.map((row) => ({
          id: row.id,
          unit_type: row.unit_type,
          statement: row.statement,
          verified: row.verification?.verified ?? false,
          used_in_article: row.usage?.used_in_article ?? false,
        })) as unknown as Record<string, unknown>[],
        ["id", "unit_type", "statement", "verified", "used_in_article"],
      );
      return;
    }
    case "show": {
      const id = positional[0];
      if (!id) {
        console.error("Usage: scout units show <id>");
        Deno.exit(1);
      }
      const unit = await apiFetch<Unit>(`/functions/v1/units/${id}`);
      const lines = [
        `ID:           ${unit.id}`,
        `Type:         ${unit.unit_type ?? "(unset)"}`,
        `Statement:    ${unit.statement ?? "(unset)"}`,
        `Source URL:   ${unit.source?.url ?? "(unset)"}`,
        `Entities:     ${
          unit.entities ? JSON.stringify(unit.entities) : "(none)"
        }`,
        `Verified:     ${unit.verification?.verified ?? false}${
          unit.verification?.verified_by
            ? ` by ${unit.verification.verified_by}`
            : ""
        }`,
        `  Notes:      ${unit.verification?.notes ?? "(none)"}`,
        `Used:         ${unit.usage?.used_in_article ?? false}${
          unit.usage?.used_at ? ` at ${unit.usage.used_at}` : ""
        }`,
        `  URL:        ${unit.usage?.used_in_url ?? "(none)"}`,
        `Deleted:      ${unit.deletion?.deleted ?? false}${
          unit.deletion?.deleted_at ? ` at ${unit.deletion.deleted_at}` : ""
        }`,
        `  Reason:     ${unit.deletion?.reason ?? "(none)"}`,
      ];
      console.log(lines.join("\n"));
      return;
    }
    case "evidence": {
      const id = positional[0];
      if (!id) {
        console.error("Usage: scout units evidence <id>");
        Deno.exit(1);
      }
      printJSON(await apiFetch(`/functions/v1/units/${id}/evidence`));
      return;
    }
    case "verify": {
      const id = positional[0];
      if (!id) {
        console.error("Usage: scout units verify <id> [--notes] [--by]");
        Deno.exit(1);
      }
      const body: Record<string, unknown> = { verified: true };
      if (typeof flags.notes === "string") {
        body.verification_notes = flags.notes;
      }
      if (typeof flags.by === "string") body.verified_by = flags.by;
      const res = await apiFetch(`/functions/v1/units/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      printJSON(res);
      return;
    }
    case "reject": {
      const id = positional[0];
      if (!id) {
        console.error("Usage: scout units reject <id> [--notes]");
        Deno.exit(1);
      }
      const body: Record<string, unknown> = { verified: false };
      if (typeof flags.notes === "string") {
        body.verification_notes = flags.notes;
      }
      const res = await apiFetch(`/functions/v1/units/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      printJSON(res);
      return;
    }
    case "mark-used": {
      const id = positional[0];
      if (!id) {
        console.error("Usage: scout units mark-used <id> [--url]");
        Deno.exit(1);
      }
      const body: Record<string, unknown> = {
        used_in_article: true,
        used_at: new Date().toISOString(),
      };
      if (typeof flags.url === "string") body.used_in_url = flags.url;
      const res = await apiFetch(`/functions/v1/units/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      printJSON(res);
      return;
    }
    case "delete": {
      const id = positional[0];
      if (!id) {
        console.error("Usage: scout units delete <id>");
        Deno.exit(1);
      }
      await apiFetch(`/functions/v1/units/${id}`, { method: "DELETE" });
      console.log(`Soft-deleted unit ${id}`);
      return;
    }
    case "search": {
      if (typeof flags.query !== "string") {
        console.error("--query is required");
        Deno.exit(1);
      }
      const body: Record<string, unknown> = {
        query_text: flags.query,
        mode: typeof flags.mode === "string" ? flags.mode : "hybrid",
      };
      if (typeof flags.project === "string") body.project_id = flags.project;
      if (typeof flags.scout === "string") body.scout_id = flags.scout;
      if (flags.verified === true) body.verified = true;
      if (flags.unverified === true) body.verified = false;
      if (flags.used === true) body.used_in_article = true;
      if (flags.unused === true) body.used_in_article = false;
      if (flags["include-deleted"] === true) body.include_deleted = true;
      if (typeof flags.limit === "string") {
        body.limit = Number(flags.limit);
      }
      const data = await apiFetch<Unit[] | { data: Unit[] }>(
        "/functions/v1/units/search",
        { method: "POST", body: JSON.stringify(body) },
      );
      const rows = Array.isArray(data)
        ? data
        : ((data as { items?: Unit[]; data?: Unit[] }).items ??
          (data as { data?: Unit[] }).data ??
          []);
      printTable(
        rows.map((row) => ({
          id: row.id,
          unit_type: row.unit_type,
          statement: row.statement,
          scout_name: row.scout_name ?? "",
          search_rank: row.search_rank ?? "",
        })) as unknown as Record<string, unknown>[],
        ["id", "unit_type", "statement", "scout_name", "search_rank"],
      );
      return;
    }
    default:
      console.error(`Unknown subcommand: ${sub}`);
      usage();
      Deno.exit(1);
  }
}

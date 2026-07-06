/**
 * MCP (Model Context Protocol) JSON-RPC 2.0 dispatcher + tool handlers.
 *
 * Wired into mcp-server/index.ts on `POST /`. Validates the caller's bearer
 * token (Supabase user JWT or `cj_<api_key>`), then forwards each tool call
 * to the sibling EF that owns the resource. This keeps auth, RLS, validation,
 * and audit paths in one place (the resource EFs) and lets the MCP server
 * stay a thin protocol adapter.
 *
 * Implements MCP 2024-11-05:
 *   - `initialize`        → capabilities handshake
 *   - `tools/list`        → enumerate tools + JSON Schema inputs
 *   - `tools/call`        → dispatch to the named handler
 *   - `notifications/initialized` → no-op (MCP spec: client finished init)
 *   - Anything else       → JSON-RPC method-not-found error
 *
 * Tool naming follows `verb_noun` to match the public-facing skill doc at
 * https://scoutpost.ai/skills/scoutpost.md (e.g. `list_scouts`, `create_scout`).
 * When adding a tool, update the skill doc in the same PR — the skill is
 * the advertised contract.
 */

import { AuthedUser, requireUserOrApiKey } from "../_shared/auth.ts";
import { logEvent } from "../_shared/log.ts";
import { baseUrl } from "./oauth/metadata.ts";

// Latest MCP Streamable HTTP spec. Claude.ai / Claude Desktop / Cowork all
// negotiate to this; we keep parity to avoid silent "Disconnected" failures.
export const MCP_PROTOCOL_VERSION = "2025-06-18";
// Older version we still accept on initialize for forward-compat with
// pre-2025-06-18 clients (mcp-remote bridge, MCP Inspector older builds).
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  MCP_PROTOCOL_VERSION,
  "2025-03-26",
  "2024-11-05",
]);
export const SERVER_NAME = "scoutpost";
const SERVER_VERSION = "0.3.0";

export function negotiateProtocolVersion(
  requested: string | undefined,
): string {
  return SUPPORTED_PROTOCOL_VERSIONS.has(requested ?? "")
    ? (requested as string)
    : MCP_PROTOCOL_VERSION;
}

// ---------------------------------------------------------------------------
// Forwarder
// ---------------------------------------------------------------------------

function efUrl(fn: string, path = ""): string {
  const base = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
  return `${base}/functions/v1/${fn}${path}`;
}

async function forward(
  token: string,
  method: string,
  fn: string,
  path: string,
  init: {
    query?: Record<string, string>;
    body?: unknown;
    accept?: string;
  } = {},
): Promise<unknown> {
  const url = new URL(efUrl(fn, path));
  for (const [k, v] of Object.entries(init.query ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (anon) {
    headers["apikey"] = anon;
    if (token.startsWith("cj_")) {
      headers["Authorization"] = `Bearer ${anon}`;
      headers["x-cojo-api-key"] = token;
    }
  }
  let body: BodyInit | undefined;
  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  if (init.accept) headers["Accept"] = init.accept;

  const res = await fetch(url.toString(), { method, headers, body });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `${fn} ${method} ${path} → ${res.status} ${text.slice(0, 400)}`,
    );
  }
  if (init.accept === "text/markdown") return text;
  return text ? JSON.parse(text) : null;
}

function q(
  args: Record<string, unknown>,
  keys: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = args[k];
    if (v === undefined || v === null || v === "") continue;
    out[k] = typeof v === "boolean" ? String(v) : String(v);
  }
  return out;
}

export function reflectionBodyForMcp(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const {
    unit_ids,
    entity_ids,
    scout_ids,
    generated_by: _ignoredGeneratedBy,
    ...rest
  } = args;
  const body: Record<string, unknown> = {
    ...rest,
    generated_by: "mcp",
  };
  if (Array.isArray(unit_ids)) body.source_unit_ids = unit_ids;
  if (Array.isArray(entity_ids)) body.source_entity_ids = entity_ids;
  if (Array.isArray(scout_ids)) {
    body.metadata = {
      ...(typeof rest.metadata === "object" && rest.metadata !== null
        ? rest.metadata as Record<string, unknown>
        : {}),
      scout_ids,
    };
  }
  return body;
}

export function mergeEntitiesBodyForMcp(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const keepId = typeof args.keep_id === "string"
    ? args.keep_id
    : typeof args.keeper_id === "string"
    ? args.keeper_id
    : undefined;
  return {
    keep_id: keepId,
    merge_ids: args.merge_ids,
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (
    user: AuthedUser,
    token: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
}

const TOOLS: ToolDef[] = [
  // ---------- Scouts ----------
  {
    name: "list_scouts",
    description:
      "List all scouts owned by the caller (id, name, type, schedule, is_active).",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 200 },
        offset: { type: "integer", minimum: 0 },
        type: { type: "string", enum: ["web", "beat", "social", "civic", "transport"] },
      },
    },
    handler: (_u, token, args) =>
      forward(token, "GET", "scouts", "", {
        query: q(args, ["limit", "offset", "type"]),
      }),
  },
  {
    name: "create_scout",
    description:
      "Create a new scout. Required: name and type (web|beat|social|civic|transport). web/beat/social/civic also need either location or topic; transport needs config (not location/topic) — see below. Topic is 1-3 short comma-separated tags for organization, not long instructions. Put long human context in description and filtering/notification rules in criteria. Web scouts require url. Beat scouts should pass criteria and optionally location/source_mode/priority_sources. Civic scouts require root_domain and tracked_urls. Social scouts require platform and profile_handle. Transport scouts require a `config` object: { mode: aircraft|vessel|satellite, watch_ids, geofence?, categories?, criteria? } — watch_ids is REQUIRED for every mode: the specific vessel MMSIs / aircraft ICAO hexes / satellite NORAD ids to track (up to 20; categories only narrow the list, they cannot replace it). Vessel and satellite scouts also need a geofence; aircraft geofence is optional. geofence is { preset_id } or { center: {lat,lon}, radius_km }. Transport supports 3h/6h/12h/daily regularity (satellite daily only). Scheduling: pass `schedule_cron` OR `regularity` + `time` (+ `day_number` for weekly/monthly). Scheduled creation establishes the baseline immediately for every scout type; Run Now compares against that baseline and never creates the first baseline.",
    inputSchema: {
      type: "object",
      required: ["name", "type"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 200 },
        type: { type: "string", enum: ["web", "beat", "social", "civic", "transport"] },
        description: {
          type: "string",
          maxLength: 2000,
          description:
            "Optional human-readable context shown on scout cards. Do not use for filtering; use criteria for filtering.",
        },
        criteria: { type: "string", maxLength: 4000 },
        topic: {
          type: "string",
          maxLength: 200,
          description:
            "Required when location is omitted. Use 1-3 short comma-separated tags, e.g. 'housing, council, budget'. Do not put long descriptions here.",
        },
        url: { type: "string", format: "uri" },
        location: {
          type: "object",
          additionalProperties: true,
          description:
            "GeocodedLocation: { displayName, latitude, longitude, ... }",
        },
        regularity: { type: "string", enum: ["daily", "weekly", "monthly", "3h", "6h", "12h"] },
        config: {
          type: "object",
          additionalProperties: true,
          description:
            "Transport scouts only: { mode: aircraft|vessel|satellite, watch_ids: string[] (REQUIRED — MMSIs/ICAO hexes/NORAD ids to track), geofence?: {preset_id}|{center:{lat,lon},radius_km}, categories?: string[] (narrows the watch list), criteria?: string }.",
        },
        schedule_cron: { type: "string", maxLength: 200 },
        day_number: { type: "integer", minimum: 0, maximum: 31 },
        time: { type: "string", pattern: "^\\d{1,2}:\\d{2}$" },
        provider: { type: "string" },
        project_id: { type: "string", format: "uuid" },
        source_mode: {
          type: "string",
          enum: ["reliable", "niche"],
          description:
            "Beat/location source discovery preference. Use reliable for established outlets, niche for local/community sources.",
        },
        excluded_domains: {
          type: "array",
          items: { type: "string" },
          description: "Domains to exclude from beat/web discovery.",
        },
        priority_sources: {
          type: "array",
          items: { type: "string" },
          description:
            "Domains or source names the scout should prioritize, e.g. ['city.gov', 'localpaper.example'].",
        },
        platform: {
          type: "string",
          enum: ["instagram", "x", "facebook", "tiktok"],
          description: "Required for social scouts.",
        },
        profile_handle: {
          type: "string",
          description:
            "Required for social scouts. Account handle or profile identifier.",
        },
        monitor_mode: {
          type: "string",
          enum: ["summarize", "criteria"],
          description:
            "Social scout mode. Use criteria when only matching posts should create units.",
        },
        track_removals: {
          type: "boolean",
          description: "For social scouts, also report removed posts.",
        },
        root_domain: {
          type: "string",
          description:
            "Required for civic scouts. Root municipal domain, e.g. 'example.gov'.",
        },
        tracked_urls: {
          type: "array",
          items: { type: "string", format: "uri" },
          minItems: 1,
          maxItems: 20,
          description:
            "Required for civic scouts. Official meeting-note, agenda, minutes, or document index URLs to monitor.",
        },
        initial_promises: {
          type: "array",
          description:
            "Optional civic seed promises already extracted by the caller.",
          items: {
            type: "object",
            required: [
              "promise_text",
              "source_url",
              "source_date",
              "date_confidence",
              "criteria_match",
            ],
            properties: {
              promise_text: { type: "string" },
              context: { type: "string" },
              source_url: { type: "string", format: "uri" },
              source_date: { type: "string", format: "date" },
              due_date: { type: "string", format: "date" },
              date_confidence: {
                type: "string",
                enum: ["high", "medium", "low"],
              },
              criteria_match: { type: "boolean" },
            },
          },
        },
      },
    },
    handler: (_u, token, args) =>
      forward(token, "POST", "scouts", "", { body: args }),
  },
  {
    name: "get_scout",
    description: "Fetch a single scout by id.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", format: "uuid" } },
    },
    handler: (_u, token, args) =>
      forward(token, "GET", "scouts", `/${String(args.id)}`),
  },
  {
    name: "update_scout",
    description:
      "Patch an existing scout. All fields optional; only sent keys change. Keep topic as 1-3 short comma-separated tags; put longer context in description and filtering/notification rules in criteria. A scout must retain either location or topic (transport scouts are scoped by config instead). For transport scouts, pass a full replacement `config` object to change mode/geofence/watch_ids/categories/criteria.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", format: "uuid" },
        name: { type: "string", minLength: 1, maxLength: 200 },
        description: { type: "string", maxLength: 2000 },
        criteria: { type: "string" },
        topic: {
          type: "string",
          description: "1-3 short comma-separated tags, not long criteria.",
        },
        url: { type: "string", format: "uri" },
        config: {
          type: "object",
          additionalProperties: true,
          description:
            "Transport scouts only: full replacement { mode: aircraft|vessel|satellite, watch_ids: string[] (REQUIRED — MMSIs/ICAO hexes/NORAD ids to track), geofence?: {preset_id}|{center:{lat,lon},radius_km}, categories?: string[] (narrows the watch list), criteria?: string }.",
        },
        regularity: { type: "string", enum: ["daily", "weekly", "monthly", "3h", "6h", "12h"] },
        schedule_cron: { type: "string" },
        day_number: { type: "integer", minimum: 0, maximum: 31 },
        time: { type: "string", pattern: "^\\d{1,2}:\\d{2}$" },
        is_active: { type: "boolean" },
        project_id: { type: "string", format: "uuid" },
        location: {
          type: "object",
          additionalProperties: true,
          description:
            "GeocodedLocation: { displayName, latitude, longitude, ... }",
        },
        source_mode: { type: "string", enum: ["reliable", "niche"] },
        excluded_domains: { type: "array", items: { type: "string" } },
        priority_sources: { type: "array", items: { type: "string" } },
        root_domain: { type: "string" },
        tracked_urls: {
          type: "array",
          items: { type: "string", format: "uri" },
          maxItems: 20,
        },
      },
    },
    handler: (_u, token, args) => {
      const { id, ...patch } = args;
      return forward(token, "PATCH", "scouts", `/${String(id)}`, {
        body: patch,
      });
    },
  },
  {
    name: "run_scout",
    description:
      "Trigger an on-demand scout run. Spends credits. Returns 202 + run_id.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", format: "uuid" } },
    },
    handler: (_u, token, args) =>
      forward(token, "POST", "scouts", `/${String(args.id)}/run`, { body: {} }),
  },
  {
    name: "pause_scout",
    description:
      "Pause a scout: set is_active=false and unschedule its cron job.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", format: "uuid" } },
    },
    handler: (_u, token, args) =>
      forward(token, "POST", "scouts", `/${String(args.id)}/pause`, {
        body: {},
      }),
  },
  {
    name: "resume_scout",
    description:
      "Resume a paused scout: set is_active=true and re-schedule its cron job.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", format: "uuid" } },
    },
    handler: (_u, token, args) =>
      forward(token, "POST", "scouts", `/${String(args.id)}/resume`, {
        body: {},
      }),
  },
  {
    name: "delete_scout",
    description: "Delete a scout and unschedule its cron job.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", format: "uuid" } },
    },
    handler: (_u, token, args) =>
      forward(token, "DELETE", "scouts", `/${String(args.id)}`),
  },

  // ---------- Units ----------
  {
    name: "list_units",
    description:
      "List information units owned by the caller. Supports project, scout, verification, usage, and deleted-state filters.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", format: "uuid" },
        scout_id: { type: "string", format: "uuid" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        offset: { type: "integer", minimum: 0 },
        verified: { type: "boolean" },
        used_in_article: { type: "boolean" },
        include_deleted: { type: "boolean" },
      },
    },
    handler: (_u, token, args) =>
      forward(token, "GET", "units", "", {
        query: q(args, [
          "project_id",
          "scout_id",
          "limit",
          "offset",
          "verified",
          "used_in_article",
          "include_deleted",
        ]),
      }),
  },
  {
    name: "search_units",
    description:
      "Search the caller's information units. Modes: semantic, keyword, or hybrid. Supports project, scout, verification, usage, and deleted-state filters.",
    inputSchema: {
      type: "object",
      required: ["query_text"],
      properties: {
        query_text: { type: "string", minLength: 1, maxLength: 4000 },
        mode: { type: "string", enum: ["semantic", "keyword", "hybrid"] },
        project_id: { type: "string", format: "uuid" },
        scout_id: { type: "string", format: "uuid" },
        verified: { type: "boolean" },
        used_in_article: { type: "boolean" },
        include_deleted: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
    handler: (_u, token, args) =>
      forward(token, "POST", "units", "/search", { body: args }),
  },
  {
    name: "get_unit",
    description: "Fetch a single information unit by id.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", format: "uuid" } },
    },
    handler: (_u, token, args) =>
      forward(token, "GET", "units", `/${String(args.id)}`),
  },
  {
    name: "verify_unit",
    description:
      "Verify a unit (accept it for editorial use). Sets verified=true, optional verification_notes and verified_by.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", format: "uuid" },
        verification_notes: { type: "string", maxLength: 4000 },
        verified_by: { type: "string", maxLength: 200 },
      },
    },
    handler: (_u, token, args) => {
      const { id, ...rest } = args;
      return forward(token, "PATCH", "units", `/${String(id)}`, {
        body: { verified: true, ...rest },
      });
    },
  },
  {
    name: "reject_unit",
    description:
      "Reject a unit (not wanted editorially). Sets verified=false and records the reason in verification_notes.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", format: "uuid" },
        verification_notes: {
          type: "string",
          maxLength: 4000,
          description: "Reason for rejection",
        },
        verified_by: { type: "string", maxLength: 200 },
      },
    },
    handler: (_u, token, args) => {
      const { id, ...rest } = args;
      return forward(token, "PATCH", "units", `/${String(id)}`, {
        body: { verified: false, ...rest },
      });
    },
  },
  {
    name: "mark_unit_used",
    description:
      "Flag a unit as used in a published article so it leaves the inbox. Optionally record the URL and timestamp.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", format: "uuid" },
        used_in_url: { type: "string", format: "uri" },
        used_at: { type: "string", format: "date-time" },
      },
    },
    handler: (_u, token, args) => {
      const { id, ...rest } = args;
      return forward(token, "PATCH", "units", `/${String(id)}`, {
        body: { used_in_article: true, ...rest },
      });
    },
  },
  {
    name: "delete_unit",
    description: "Soft-delete an information unit by id.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", format: "uuid" } },
    },
    handler: (_u, token, args) =>
      forward(token, "DELETE", "units", `/${String(args.id)}`),
  },

  // ---------- Projects ----------
  {
    name: "list_projects",
    description: "List investigation projects owned by the caller.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 200 },
        offset: { type: "integer", minimum: 0 },
      },
    },
    handler: (_u, token, args) =>
      forward(token, "GET", "projects", "", {
        query: q(args, ["limit", "offset"]),
      }),
  },
  {
    name: "create_project",
    description:
      "Create a new investigation project (a workspace for grouping scouts + units).",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 120 },
        description: { type: "string", maxLength: 2000 },
        visibility: {
          type: "string",
          enum: ["private", "team"],
          default: "private",
        },
        tags: { type: "array", items: { type: "string" }, maxItems: 30 },
      },
    },
    handler: (_u, token, args) =>
      forward(token, "POST", "projects", "", { body: args }),
  },
  {
    name: "get_project",
    description: "Fetch a single project by id.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", format: "uuid" } },
    },
    handler: (_u, token, args) =>
      forward(token, "GET", "projects", `/${String(args.id)}`),
  },
  {
    name: "update_project",
    description: "Patch a project — name, description, visibility, or tags.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", format: "uuid" },
        name: { type: "string", minLength: 1, maxLength: 120 },
        description: { type: "string", maxLength: 2000 },
        visibility: { type: "string", enum: ["private", "team"] },
        tags: { type: "array", items: { type: "string" }, maxItems: 30 },
      },
    },
    handler: (_u, token, args) => {
      const { id, ...patch } = args;
      return forward(token, "PATCH", "projects", `/${String(id)}`, {
        body: patch,
      });
    },
  },
  {
    name: "delete_project",
    description: "Delete a project by id.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", format: "uuid" } },
    },
    handler: (_u, token, args) =>
      forward(token, "DELETE", "projects", `/${String(args.id)}`),
  },

  // ---------- Ingest ----------
  {
    name: "ingest_content",
    description:
      "Ingest a URL or raw text into the knowledge base. Creates a raw_capture row and extracts atomic information_units via Gemini.",
    inputSchema: {
      type: "object",
      required: ["kind"],
      properties: {
        kind: { type: "string", enum: ["url", "text"] },
        url: {
          type: "string",
          format: "uri",
          description: "Required when kind=url",
        },
        text: { type: "string", description: "Required when kind=text" },
        title: { type: "string" },
        criteria: {
          type: "string",
          description: "Optional extraction criteria",
        },
        notes: { type: "string" },
        project_id: { type: "string", format: "uuid" },
      },
    },
    handler: (_u, token, args) =>
      forward(token, "POST", "ingest", "", { body: args }),
  },

  // ---------- Reflections ----------
  {
    name: "list_reflections",
    description:
      "List editorial reflections (agent-written synthesized summaries) owned by the caller.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 200 },
        offset: { type: "integer", minimum: 0 },
      },
    },
    handler: (_u, token, args) =>
      forward(token, "GET", "reflections", "", {
        query: q(args, ["limit", "offset"]),
      }),
  },
  {
    name: "create_reflection",
    description:
      "Create a reflection (durable editorial note) over scouts, units, or entities. Embedded at write time for semantic search.",
    inputSchema: {
      type: "object",
      required: ["scope_description", "content"],
      properties: {
        scope_description: { type: "string", minLength: 1 },
        content: { type: "string", minLength: 1 },
        unit_ids: { type: "array", items: { type: "string", format: "uuid" } },
        entity_ids: {
          type: "array",
          items: { type: "string", format: "uuid" },
        },
        scout_ids: {
          type: "array",
          items: { type: "string", format: "uuid" },
          description:
            "Optional scout IDs to retain as reflection metadata.scout_ids; the reflections API has first-class source links only for units and entities.",
        },
      },
    },
    handler: (_u, token, args) =>
      forward(token, "POST", "reflections", "", {
        body: reflectionBodyForMcp(args),
      }),
  },
  {
    name: "search_reflections",
    description: "Semantic search over the caller's reflections.",
    inputSchema: {
      type: "object",
      required: ["query_text"],
      properties: {
        query_text: { type: "string", minLength: 1, maxLength: 4000 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
    handler: (_u, token, args) =>
      forward(token, "POST", "reflections", "/search", { body: args }),
  },

  // ---------- Entities ----------
  {
    name: "search_entities",
    description:
      "Find canonical entities (people, orgs, places, policies) across the knowledge base. Returns entity rows with type + canonical_name.",
    inputSchema: {
      type: "object",
      properties: {
        search: {
          type: "string",
          description: "Substring match on canonical_name",
        },
        type: { type: "string", enum: ["person", "org", "place", "policy"] },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        offset: { type: "integer", minimum: 0 },
      },
    },
    handler: (_u, token, args) =>
      forward(token, "GET", "entities", "", {
        query: q(args, ["search", "type", "limit", "offset"]),
      }),
  },
  {
    name: "merge_entities",
    description:
      "Collapse duplicate entities into a single keeper. Use after `search_entities` surfaces near-duplicates.",
    inputSchema: {
      type: "object",
      required: ["merge_ids"],
      oneOf: [
        { required: ["keep_id"] },
        { required: ["keeper_id"] },
      ],
      properties: {
        keep_id: { type: "string", format: "uuid" },
        keeper_id: {
          type: "string",
          format: "uuid",
          deprecated: true,
          description: "Deprecated alias for keep_id.",
        },
        merge_ids: {
          type: "array",
          items: { type: "string", format: "uuid" },
          minItems: 1,
        },
      },
    },
    handler: (_u, token, args) =>
      forward(token, "POST", "entities", "/merge", {
        body: mergeEntitiesBodyForMcp(args),
      }),
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------
// JSON-RPC 2.0
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

function rpcOk(id: unknown, result: unknown): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

function rpcErr(
  id: unknown,
  err: JsonRpcErrorBody,
  httpStatus = 200,
): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: err }),
    {
      status: httpStatus,
      headers: { "Content-Type": "application/json" },
    },
  );
}

/**
 * RFC 9728 §5.3 + MCP Authorization spec: when a protected MCP method is
 * called without (or with an invalid) bearer token, respond HTTP 401 with
 * a `WWW-Authenticate: Bearer` challenge that points at our protected-
 * resource metadata. This is the signal that makes MCP clients (claude.ai,
 * Claude Desktop, Claude Code, MCP Inspector) trigger OAuth/DCR. Returning
 * a JSON-RPC error inside HTTP 200 looks like "method failed" and the
 * client never starts the OAuth flow.
 */
function unauthorized(id: unknown, reason: string): Response {
  const resourceMetadata = `${baseUrl()}/.well-known/oauth-protected-resource`;
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: id ?? null,
      error: { code: -32001, message: reason },
    }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate":
          `Bearer realm="MCP", error="invalid_token", resource_metadata="${resourceMetadata}"`,
      },
    },
  );
}

async function readRpcBody(req: Request): Promise<JsonRpcRequest | null> {
  try {
    const body = (await req.json()) as JsonRpcRequest;
    if (body?.jsonrpc !== "2.0" || typeof body.method !== "string") return null;
    return body;
  } catch {
    return null;
  }
}

export async function handleRpc(
  req: Request,
  requestId?: string,
): Promise<Response> {
  const body = await readRpcBody(req);
  if (!body) {
    logEvent({
      level: "warn",
      fn: "mcp-server.rpc",
      event: "parse_error",
      request_id: requestId,
    });
    return rpcErr(null, { code: -32700, message: "Parse error" }, 400);
  }

  logEvent({
    level: "info",
    fn: "mcp-server.rpc",
    event: "rpc_in",
    request_id: requestId,
    method: body.method,
    rpc_id: body.id ?? null,
    has_auth:
      !!(req.headers.get("authorization") ?? req.headers.get("Authorization")),
  });

  // Auth gate runs BEFORE any method dispatch — including the
  // `initialize` handshake. Why: Anthropic's Cowork connector card
  // chooses between "Configure" (server reachable, auth optional) and
  // "Connect" (auth required, kick off DCR + OAuth) based on whether
  // the very first unauthenticated probe returns 200 or 401. If we
  // happily 200 on initialize without a bearer, the card defaults to
  // Configure and the user has to manually disconnect+reconnect to
  // trigger the OAuth flow. Returning 401+WWW-Authenticate up front
  // signals "this resource is OAuth-protected" exactly per the MCP
  // Authorization spec, and Claude clients then fetch our
  // /.well-known/oauth-protected-resource metadata, run DCR, and only
  // re-issue initialize once they've minted a token.
  let user: AuthedUser;
  let token: string;
  try {
    user = await requireUserOrApiKey(req);
    const header = req.headers.get("authorization") ??
      req.headers.get("Authorization") ?? "";
    const forwardedApiKey = req.headers.get("x-cojo-api-key") ??
      req.headers.get("X-Cojo-Api-Key") ?? "";
    token = forwardedApiKey.trim() ||
      (header.startsWith("Bearer ") ? header.slice(7).trim() : "");
    if (!token) {
      return unauthorized(body.id, "missing bearer token");
    }
  } catch (e) {
    return unauthorized(
      body.id,
      e instanceof Error ? e.message : "unauthorized",
    );
  }

  if (body.method === "initialize") {
    // Echo the client's requested protocolVersion when we support it; fall
    // back to our advertised default. MCP clients (Claude.ai in particular)
    // disconnect if the server picks a version they don't recognise.
    return rpcOk(body.id, {
      protocolVersion: negotiateProtocolVersion(
        body.params?.protocolVersion as string | undefined,
      ),
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: { listChanged: false } },
    });
  }
  if (body.method === "notifications/initialized") {
    // JSON-RPC notification — no response. Deno.serve still needs a 202.
    return new Response(null, { status: 202 });
  }

  if (body.method === "tools/list") {
    const toolsList = TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    const responseBody = JSON.stringify({
      jsonrpc: "2.0",
      id: body.id ?? null,
      result: { tools: toolsList },
    });
    logEvent({
      level: "info",
      fn: "mcp-server.rpc",
      event: "tools_list_served",
      request_id: requestId,
      tool_count: toolsList.length,
      response_bytes: responseBody.length,
    });
    return new Response(responseBody, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (body.method === "tools/call") {
    const params = body.params ?? {};
    const name = typeof params.name === "string" ? params.name : "";
    const args = (params.arguments as Record<string, unknown> | undefined) ??
      {};
    const tool = TOOL_BY_NAME.get(name);
    if (!tool) {
      return rpcErr(body.id, {
        code: -32602,
        message: `unknown tool: ${name}`,
      });
    }
    try {
      const result = await tool.handler(user, token, args);
      const text = typeof result === "string" ? result : JSON.stringify(result);
      return rpcOk(body.id, {
        content: [{ type: "text", text }],
        isError: false,
      });
    } catch (e) {
      logEvent({
        level: "error",
        fn: "mcp-server",
        event: "tool_call_failed",
        user_id: user.id,
        msg: `${name}: ${e instanceof Error ? e.message : String(e)}`,
      });
      return rpcOk(body.id, {
        content: [{
          type: "text",
          text: e instanceof Error ? e.message : String(e),
        }],
        isError: true,
      });
    }
  }

  return rpcErr(body.id, {
    code: -32601,
    message: `Method not found: ${body.method}`,
  });
}

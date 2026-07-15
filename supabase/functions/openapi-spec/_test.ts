/**
 * openapi-spec tests.
 *
 * Two layers:
 *
 *   Structural (offline, runs without Supabase) — imports spec.json and asserts
 *   every path + tool the product publicly commits to is present. Breaks
 *   immediately when someone drops a route or renames a field.
 *
 *   HTTP (online, requires `supabase start`) — verifies the EF actually serves
 *   the spec as application/json with the correct openapi version.
 */

import {
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import spec from "./spec.json" with { type: "json" };

type SpecDoc = {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, unknown>>;
  components: {
    schemas: Record<string, unknown>;
    securitySchemes: Record<string, unknown>;
  };
};

const doc = spec as unknown as SpecDoc;

function maybeEnv(name: string): string | null {
  try {
    return Deno.env.get(name) ?? null;
  } catch {
    return null;
  }
}

function functionUrl(name: string, path = ""): string {
  const base = maybeEnv("SUPABASE_URL");
  if (!base) throw new Error("SUPABASE_URL not configured for online tests");
  return `${base}/functions/v1/${name}${path}`;
}

const HAS_SUPABASE_URL = Boolean(maybeEnv("SUPABASE_URL"));

// ---------------------------------------------------------------------------
// Offline structural assertions — catch drift the moment a route disappears.
// ---------------------------------------------------------------------------

const REQUIRED_PATHS: Array<[string, string[]]> = [
  ["/scouts", ["get", "post"]],
  ["/scouts/{id}", ["get", "patch", "delete"]],
  ["/scouts/{id}/run", ["post"]],
  ["/scouts/{id}/pause", ["post"]],
  ["/scouts/{id}/resume", ["post"]],
  ["/transport-test", ["post"]],
  ["/scouts/from-template", ["post"]],
  ["/units", ["get"]],
  ["/units/locations", ["get"]],
  ["/units/topics", ["get"]],
  ["/units/all", ["get"]],
  ["/units/unused", ["get"]],
  ["/units/by-topic", ["get"]],
  ["/units/search", ["get", "post"]],
  ["/units/mark-used", ["patch"]],
  ["/units/{id}", ["get", "patch", "delete"]],
  ["/projects", ["get", "post"]],
  ["/projects/{id}", ["get", "patch", "delete"]],
  ["/entities", ["get", "post"]],
  ["/entities/merge", ["post"]],
  ["/reflections", ["get", "post"]],
  ["/reflections/search", ["post"]],
  ["/reflections/{id}", ["get", "delete"]],
  ["/ingest", ["post"]],
  ["/user/me", ["get"]],
  ["/user/preferences", ["get", "patch"]],
  ["/api-keys", ["get", "post"]],
  ["/api-keys/{id}", ["delete"]],
  ["/mcp-server", ["post"]],
  ["/openapi-spec", ["get"]],
];

Deno.test("spec.json — OpenAPI 3.1.0 header + version present", () => {
  assertEquals(doc.openapi, "3.1.0");
  assertExists(doc.info?.version);
  assertEquals(doc.info.title, "Scoutpost API");
});

Deno.test("spec.json — every advertised path + method is declared", () => {
  for (const [path, methods] of REQUIRED_PATHS) {
    const node = doc.paths[path];
    if (!node) throw new Error(`missing path: ${path}`);
    for (const m of methods) {
      if (!node[m]) {
        throw new Error(`missing method on ${path}: ${m}`);
      }
    }
  }
});

Deno.test("spec.json — security schemes bearer + apikey both declared", () => {
  assertExists(doc.components.securitySchemes.bearerAuth);
  assertExists(doc.components.securitySchemes.anonKey);
});

Deno.test("spec.json — verification workflow exposed via Unit + UnitUpdate", () => {
  const unit = doc.components.schemas.Unit as {
    properties: Record<string, unknown>;
  };
  for (
    const field of [
      "verification",
      "usage",
      "deletion",
      "occurrence_count",
      "sources",
      "linked_scouts",
      "scout_name",
    ]
  ) {
    if (!unit.properties[field]) {
      throw new Error(`Unit schema missing ${field}`);
    }
  }
  const patch = doc.components.schemas.UnitUpdate as {
    properties: Record<string, unknown>;
  };
  for (
    const field of [
      "verified",
      "verified_by",
      "verification_notes",
      "used_in_article",
      "used_in_url",
      "used_at",
      "deletion_reason",
    ]
  ) {
    if (!patch.properties[field]) {
      throw new Error(`UnitUpdate schema missing ${field}`);
    }
  }
});

Deno.test("spec.json — Scout schema enumerates all scout types", () => {
  const scoutType = doc.components.schemas.ScoutType as { enum: string[] };
  assertEquals([...scoutType.enum].sort(), [
    "beat",
    "civic",
    "social",
    "transport",
    "web",
  ]);
});

Deno.test("spec.json — social creation is criteria-first without hiding legacy REST fallback", () => {
  const create = doc.components.schemas.ScoutCreate as {
    properties: Record<string, {
      enum?: string[];
      description?: string;
      "x-client-default"?: string;
    }>;
  };
  for (
    const field of [
      "platform",
      "profile_handle",
      "monitor_mode",
      "track_removals",
    ]
  ) {
    assertExists(create.properties[field], `ScoutCreate missing ${field}`);
  }
  assertEquals(create.properties.monitor_mode.enum, ["summarize", "criteria"]);
  assertEquals(
    create.properties.monitor_mode["x-client-default"],
    "criteria",
  );
  assertStringIncludes(
    create.properties.monitor_mode.description ?? "",
    "omit both monitor_mode and criteria",
  );

  const update = doc.components.schemas.ScoutUpdate as {
    properties: Record<string, unknown>;
  };
  const scout = doc.components.schemas.Scout as {
    properties: Record<string, unknown>;
  };
  for (
    const field of [
      "platform",
      "profile_handle",
      "monitor_mode",
      "track_removals",
    ]
  ) {
    assertExists(update.properties[field], `ScoutUpdate missing ${field}`);
    assertExists(scout.properties[field], `Scout response missing ${field}`);
  }
});

Deno.test("spec.json — Fleet Scout contract requires a circular entry area", () => {
  const config = doc.components.schemas.TransportConfig as {
    required: string[];
    properties: Record<string, unknown>;
  };
  assertEquals(config.required, ["mode", "watch_ids", "geofence"]);
  assertExists(config.properties.geofence);
  const area = doc.components.schemas.TransportArea as {
    required: string[];
    properties: { radius_km: { maximum: number } };
  };
  assertEquals(area.required, ["center", "radius_km"]);
  assertEquals(area.properties.radius_km.maximum, 1500);
});

Deno.test("spec.json — Fleet Scout exposes the two-step tested-baseline contract", () => {
  const create = doc.components.schemas.ScoutCreate as {
    properties: Record<string, unknown>;
  };
  assertExists(create.properties.transport_baseline_ids);

  const testRoute = doc.paths["/transport-test"].post as {
    requestBody: {
      content: { "application/json": { schema: { required: string[] } } };
    };
    responses: Record<string, {
      content?: {
        "application/json"?: {
          schema?: {
            required?: string[];
            properties?: Record<string, unknown>;
          };
        };
      };
    }>;
  };
  assertEquals(
    testRoute.requestBody.content["application/json"].schema.required,
    ["config"],
  );
  const success = testRoute.responses["200"].content?.["application/json"]
    ?.schema;
  assertExists(success);
  assertEquals(success.required, ["valid", "baseline_ids", "preview"]);
  assertExists(success.properties?.baseline_ids);
  assertExists(testRoute.responses["403"]);
  assertExists(testRoute.responses["503"]);
});

Deno.test("spec.json — inbox filter parameters present on GET /units", () => {
  const get = doc.paths["/units"].get as {
    parameters: Array<{ name: string }>;
  };
  const names = get.parameters.map((p) => p.name);
  for (
    const expected of [
      "verified",
      "used_in_article",
      "include_deleted",
      "project_id",
      "scout_id",
      "from",
      "to",
    ]
  ) {
    if (!names.includes(expected)) {
      throw new Error(`GET /units missing parameter: ${expected}`);
    }
  }
});

Deno.test("spec.json — POST /units/search documents mode + scope/state filters", () => {
  const post = doc.paths["/units/search"].post as {
    requestBody: {
      content: {
        "application/json": {
          schema: {
            properties: Record<string, unknown>;
          };
        };
      };
    };
  };
  const props = post.requestBody.content["application/json"].schema.properties;
  assertExists(props.query_text);
  assertExists(props.mode);
  assertExists(props.project_id);
  assertExists(props.scout_id);
  assertExists(props.verified);
  assertExists(props.used_in_article);
  assertExists(props.include_deleted);
  assertExists(props.limit);
});

Deno.test("spec.json — live legacy units compatibility routes are documented as deprecated", () => {
  const legacyRoutes = [
    ["/units/locations", "get"],
    ["/units/topics", "get"],
    ["/units/all", "get"],
    ["/units/unused", "get"],
    ["/units/by-topic", "get"],
    ["/units/search", "get"],
    ["/units/mark-used", "patch"],
  ] as const;

  for (const [path, method] of legacyRoutes) {
    const operation = doc.paths[path]?.[method] as
      | { deprecated?: boolean }
      | undefined;
    if (!operation) throw new Error(`missing legacy route: ${method} ${path}`);
    assertEquals(operation.deprecated, true);
  }
});

Deno.test("spec.json — Scout schema documents structured last_run", () => {
  const scout = doc.components.schemas.Scout as {
    properties: Record<string, { properties?: Record<string, unknown> }>;
  };
  const lastRun = scout.properties.last_run;
  if (!lastRun?.properties) {
    throw new Error("Scout schema last_run should be an object");
  }
  for (
    const field of [
      "started_at",
      "status",
      "articles_count",
      "merged_existing_count",
    ]
  ) {
    if (!lastRun.properties[field]) {
      throw new Error(`Scout.last_run missing ${field}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Online HTTP assertion — kept for integration coverage. Skipped unless the
// local Supabase stack is reachable (tests depend on `_shared/_testing.ts`).
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "openapi-spec HTTP: GET returns 200 application/json with openapi 3.1.0",
  ignore: !HAS_SUPABASE_URL,
  fn: async () => {
    const res = await fetch(functionUrl("openapi-spec"), { method: "GET" });
    assertEquals(res.status, 200);
    const ct = res.headers.get("content-type") ?? "";
    assertStringIncludes(ct, "application/json");
    const body = await res.json();
    assertEquals(body.openapi, "3.1.0");
    assertExists(body.paths["/projects"]);
    assertExists(body.paths["/scouts/{id}/run"]);
  },
});

Deno.test({
  name: "openapi-spec HTTP: HEAD returns 200 application/json without 405",
  ignore: !HAS_SUPABASE_URL,
  fn: async () => {
    const res = await fetch(functionUrl("openapi-spec"), { method: "HEAD" });
    assertEquals(res.status, 200);
    const ct = res.headers.get("content-type") ?? "";
    assertStringIncludes(ct, "application/json");
    const body = await res.text();
    assertEquals(body, "");
  },
});

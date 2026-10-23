/**
 * Pure action-parity tests for the MCP tool roster (no Supabase/auth needed —
 * kept out of _test.ts, which requires a live test-Supabase URL at module load).
 *
 * ce-agent-native-architecture discipline: every UI action must have an
 * equivalent agent tool. The Page Archive UI toggle (archive_enabled /
 * wayback_enabled at Page Scout scheduling) and the snapshot-retrieval surface
 * must therefore be reachable through MCP tools. These tests fail loudly if a
 * future refactor drops that parity.
 */
import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
  assertThrows,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  createScoutBodyForMcp,
  listedTools,
  mergeEntitiesBodyForMcp,
  TOOLS,
} from "./rpc.ts";

Deno.test("mcp parity: page-archive retrieval is exposed as agent tools", () => {
  const names = TOOLS.map((t) => t.name);
  assertEquals(names.includes("list_snapshots"), true);
  assertEquals(names.includes("get_snapshot_url"), true);
});

Deno.test("mcp create_scout does not advertise retired Page provider selection", () => {
  const tool = TOOLS.find((candidate) => candidate.name === "create_scout");
  assertExists(tool);
  const properties = (tool.inputSchema as {
    properties?: Record<string, unknown>;
  }).properties ?? {};
  assertEquals("provider" in properties, false);
});

Deno.test("mcp Page Scout criteria schema explains noisy Any Change fallback", () => {
  for (const name of ["create_scout", "update_scout"]) {
    const tool = TOOLS.find((candidate) => candidate.name === name);
    assertExists(tool);
    const criteria = (tool!.inputSchema as {
      properties: { criteria?: { description?: string } };
    }).properties.criteria;
    assertStringIncludes(criteria?.description ?? "", "Specific Criteria");
    assertStringIncludes(criteria?.description ?? "", "Any Change");
  }
});

Deno.test("mcp parity: create/update_scout advertise the archive + wayback toggle", () => {
  for (const name of ["create_scout", "update_scout"]) {
    const tool = TOOLS.find((t) => t.name === name);
    assertExists(tool, `${name} tool missing`);
    const props =
      (tool!.inputSchema as { properties?: Record<string, unknown> })
        .properties ??
        {};
    assertEquals(
      "archive_enabled" in props,
      true,
      `${name} missing archive_enabled`,
    );
    assertEquals(
      "wayback_enabled" in props,
      true,
      `${name} missing wayback_enabled`,
    );
  }
});

Deno.test("mcp create_scout defaults social scouts to criteria mode", () => {
  assertEquals(
    createScoutBodyForMcp({
      name: "Council posts",
      type: "social",
      platform: "x",
      profile_handle: "citycouncil",
      criteria: "housing votes",
    }).monitor_mode,
    "criteria",
  );
  assertThrows(
    () =>
      createScoutBodyForMcp({
        name: "Council posts",
        type: "social",
        platform: "x",
        profile_handle: "citycouncil",
      }),
    Error,
    "criteria is required",
  );
  assertEquals(
    createScoutBodyForMcp({
      name: "Council digest",
      type: "social",
      platform: "x",
      profile_handle: "citycouncil",
      monitor_mode: "summarize",
    }).monitor_mode,
    "summarize",
  );
});

Deno.test("mcp parity: social mode is criteria-first on create and patchable", () => {
  const create = TOOLS.find((tool) => tool.name === "create_scout");
  const update = TOOLS.find((tool) => tool.name === "update_scout");
  assertExists(create);
  assertExists(update);
  const createProps = (create.inputSchema as {
    properties: Record<string, { default?: string }>;
  }).properties;
  assertEquals(createProps.monitor_mode.default, "criteria");
  const updateProps = (update.inputSchema as {
    properties: Record<string, unknown>;
  }).properties;
  for (
    const field of [
      "platform",
      "profile_handle",
      "monitor_mode",
      "track_removals",
    ]
  ) {
    assertEquals(field in updateProps, true, `update_scout missing ${field}`);
  }
});

Deno.test("mcp parity: Fleet Scout contract requires an entry area", () => {
  for (const name of ["create_scout", "update_scout"]) {
    const tool = TOOLS.find((t) => t.name === name);
    assertExists(tool);
    const config = (tool!.inputSchema as {
      properties: Record<
        string,
        { required?: string[]; properties?: Record<string, unknown> }
      >;
    }).properties.config;
    assertEquals(config.required, ["mode", "watch_ids", "geofence"]);
    assertEquals("geofence" in (config.properties ?? {}), true);
    const geofence = config.properties?.geofence as {
      properties?: { radius_km?: { maximum?: number } };
    };
    assertEquals(geofence.properties?.radius_km?.maximum, 1500);
  }
});

Deno.test("mcp parity: Fleet Scout creation exposes test then baseline handoff", () => {
  const testTool = TOOLS.find((tool) => tool.name === "test_transport_config");
  const createTool = TOOLS.find((tool) => tool.name === "create_scout");
  assertExists(testTool);
  assertExists(createTool);

  const testProps = testTool.inputSchema as {
    required?: string[];
    properties: Record<string, unknown>;
  };
  assertEquals(testProps.required, ["config"]);
  assertExists(testProps.properties.config);

  const createProps = (createTool.inputSchema as {
    properties: Record<string, unknown>;
  }).properties;
  assertExists(createProps.transport_baseline_ids);
  assertEquals(
    createScoutBodyForMcp({
      name: "Harbour watch",
      type: "transport",
      config: {
        mode: "vessel",
        watch_ids: ["636019825"],
        geofence: {
          center: { lat: 26.55, lon: 56.25 },
          radius_km: 40,
        },
      },
      transport_baseline_ids: [],
    }).transport_baseline_ids,
    [],
  );
});

Deno.test("mcp parity: get_snapshot_url enumerates all six artifact kinds", () => {
  const tool = TOOLS.find((t) => t.name === "get_snapshot_url");
  assertExists(tool);
  const artifact = (tool!.inputSchema as {
    properties: { artifact: { enum: string[] } };
  }).properties.artifact;
  assertEquals(
    [...artifact.enum].sort(),
    ["manifest", "markdown", "mhtml", "rawhtml", "screenshot", "tsr"],
  );
});

// OpenAI's plugin directory requires explicit readOnly/destructive/openWorld
// booleans on every listed tool and rejects labels that contradict behaviour.
Deno.test("mcp tools/list labels every tool, deletes as destructive and reads as read-only", () => {
  const listed = listedTools();
  assertEquals(listed.length, TOOLS.length);
  for (const tool of listed) {
    for (const hint of ["readOnlyHint", "destructiveHint", "openWorldHint"] as const) {
      assertEquals(typeof tool.annotations?.[hint], "boolean", `${tool.name}.${hint}`);
    }
    if (/^(delete|merge|update)_/.test(tool.name)) {
      assertEquals(tool.annotations.destructiveHint, true, tool.name);
      assertEquals(tool.annotations.readOnlyHint, false, tool.name);
    }
    if (/^(list|get|search)_/.test(tool.name)) {
      assertEquals(tool.annotations.readOnlyHint, true, tool.name);
      assertEquals(tool.annotations.destructiveHint, false, tool.name);
    }
  }
});

// Osaurus plan R7: for Osaurus every tool is open-world, so Osaurus asks
// before each call; nothing else about a tool changes.
Deno.test("mcp tools/list marks every tool open-world for Osaurus only", () => {
  const plain = listedTools();
  const osaurus = listedTools({ openWorld: true });
  assertEquals(osaurus.length, plain.length);
  for (const [i, tool] of osaurus.entries()) {
    assertEquals(tool.annotations.openWorldHint, true, tool.name);
    assertEquals({ ...tool.annotations, openWorldHint: plain[i].annotations.openWorldHint }, plain[i].annotations, tool.name);
  }
  assert(plain.some((t) => t.annotations.readOnlyHint && !t.annotations.openWorldHint), "some read tools stay closed-world for other clients");
});

type SchemaNode = Record<string, unknown>;
const isNode = (v: unknown): v is SchemaNode =>
  !!v && typeof v === "object" && !Array.isArray(v);

// Port of what Goose 1.54.0 does to MCP schemas before sending them to
// OpenRouter (validate_tool_schemas / sanitize_schema_node in
// crates/goose-provider-types/src/formats/openai.rs): oneOf becomes anyOf and
// every type "object" node gains properties {} and required [].
function gooseRewrite(node: unknown): unknown {
  if (!isNode(node)) return node;
  const out: SchemaNode = { ...node };
  if (!("anyOf" in out) && "oneOf" in out) {
    out.anyOf = out.oneOf;
    delete out.oneOf;
  }
  if (out.type === "object") {
    out.properties ??= {};
    out.required ??= [];
  }
  for (const key of ["properties", "$defs", "definitions"]) {
    if (isNode(out[key])) {
      out[key] = Object.fromEntries(
        Object.entries(out[key] as SchemaNode).map((
          [k, v],
        ) => [k, gooseRewrite(v)]),
      );
    }
  }
  for (const key of ["anyOf", "allOf", "prefixItems"]) {
    if (Array.isArray(out[key])) {
      out[key] = (out[key] as unknown[]).map(gooseRewrite);
    }
  }
  for (const key of ["items", "additionalProperties"]) {
    if (isNode(out[key])) out[key] = gooseRewrite(out[key]);
  }
  return out;
}

// Rules Google applies to function-declaration parameters (Vertex AI served
// the BUR-38 error: "schema type should be OBJECT"). `type` is a single
// required value (https://ai.google.dev/api/generate-content#Schema); a node
// using anyOf may set no other field, and each `required` name must be
// defined in `properties` (reported in anomalyco/opencode#14509 and #3140);
// an object needs at least one property ("properties: should be non-empty for
// OBJECT type", agno-agi/agno#2112). allOf/if/then/not and oneOf are not
// Schema fields at all.
function vertexSchemaProblems(node: unknown, path: string): string[] {
  if (!isNode(node)) return [];
  const problems: string[] = [];
  const unsupported = [
    "oneOf",
    "allOf",
    "if",
    "then",
    "else",
    "not",
    "$ref",
    "$defs",
    "definitions",
  ]
    .filter((key) => key in node);
  if (unsupported.length) {
    problems.push(`${path}: unsupported ${unsupported.join(", ")}`);
  }
  if ("anyOf" in node) {
    const siblings = Object.keys(node).filter((key) => key !== "anyOf");
    if (siblings.length) {
      problems.push(`${path}: anyOf alongside ${siblings.join(", ")}`);
    }
  } else if (typeof node.type !== "string") {
    problems.push(
      `${path}: type must be a single string, got ${JSON.stringify(node.type)}`,
    );
  } else if ((node.properties || node.required) && node.type !== "object") {
    problems.push(`${path}: properties/required need type "object"`);
  }
  if (node.enum && node.type !== "string") {
    problems.push(`${path}: enum is only supported on string schemas`);
  }
  const properties = isNode(node.properties) ? node.properties : {};
  if (node.type === "object" && Object.keys(properties).length === 0) {
    problems.push(`${path}: object needs at least one property`);
  }
  for (const name of Array.isArray(node.required) ? node.required : []) {
    if (!(name in properties)) {
      problems.push(`${path}.required: ${name} is not defined`);
    }
  }
  for (const [name, child] of Object.entries(properties)) {
    problems.push(...vertexSchemaProblems(child, `${path}.properties.${name}`));
  }
  if (node.items) {
    problems.push(...vertexSchemaProblems(node.items, `${path}.items`));
  }
  for (const key of ["anyOf", "allOf"]) {
    const branches = node[key];
    if (Array.isArray(branches)) {
      branches.forEach((b, i) =>
        problems.push(...vertexSchemaProblems(b, `${path}.${key}[${i}]`))
      );
    }
  }
  return problems;
}

Deno.test("mcp tools/list schemas pass Gemini's function-declaration rules as Goose sends them", () => {
  const problems = listedTools().flatMap((tool) =>
    vertexSchemaProblems(gooseRewrite(tool.inputSchema), tool.name)
  );
  assertEquals(problems, []);
});

Deno.test("mcp merge_entities rejects calls without exactly one of keep_id or keeper_id", () => {
  const keep = "11111111-1111-1111-1111-111111111111";
  const merge_ids = ["22222222-2222-2222-2222-222222222222"];
  assertThrows(
    () => mergeEntitiesBodyForMcp({ merge_ids }),
    Error,
    "exactly one of keep_id",
  );
  assertThrows(
    () =>
      mergeEntitiesBodyForMcp({ merge_ids, keep_id: keep, keeper_id: keep }),
    Error,
    "exactly one of keep_id",
  );
});

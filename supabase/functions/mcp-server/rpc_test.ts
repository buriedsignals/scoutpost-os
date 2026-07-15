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
  assertEquals,
  assertExists,
  assertThrows,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createScoutBodyForMcp, TOOLS } from "./rpc.ts";

Deno.test("mcp parity: page-archive retrieval is exposed as agent tools", () => {
  const names = TOOLS.map((t) => t.name);
  assertEquals(names.includes("list_snapshots"), true);
  assertEquals(names.includes("get_snapshot_url"), true);
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

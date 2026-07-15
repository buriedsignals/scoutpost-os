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
import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { TOOLS } from "./rpc.ts";

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
      (tool!.inputSchema as { properties?: Record<string, unknown> }).properties ??
        {};
    assertEquals("archive_enabled" in props, true, `${name} missing archive_enabled`);
    assertEquals("wayback_enabled" in props, true, `${name} missing wayback_enabled`);
  }
});

Deno.test("mcp parity: Fleet Scout contract requires an entry area", () => {
  for (const name of ["create_scout", "update_scout"]) {
    const tool = TOOLS.find((t) => t.name === name);
    assertExists(tool);
    const config = ((tool!.inputSchema as { properties: Record<string, { required?: string[]; properties?: Record<string, unknown> }> }).properties.config);
    assertEquals(config.required, ["mode", "watch_ids", "geofence"]);
    assertEquals("geofence" in (config.properties ?? {}), true);
  }
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

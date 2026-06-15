// Deno tests for the shared platform -> release-asset mapping.
// Runs under `deno task test` (the release workflow invokes this on every leg),
// guarding the asset names the launcher and postinstall both depend on.

import { assert, assertEquals } from "jsr:@std/assert";

import {
  getTargetAsset,
  getTargetKey,
  normalizeArch,
  SUPPORTED_ASSETS,
} from "./platform.js";

Deno.test("getTargetAsset: happy path for all four supported targets", () => {
  assertEquals(getTargetAsset("darwin", "arm64"), "scout-darwin-arm64");
  assertEquals(getTargetAsset("darwin", "x64"), "scout-darwin-x86_64");
  assertEquals(getTargetAsset("linux", "arm64"), "scout-linux-arm64");
  assertEquals(getTargetAsset("linux", "x64"), "scout-linux-x86_64");
});

Deno.test("getTargetAsset: accepts aarch64 and x86_64 arch aliases", () => {
  assertEquals(getTargetAsset("darwin", "aarch64"), "scout-darwin-arm64");
  assertEquals(getTargetAsset("linux", "x86_64"), "scout-linux-x86_64");
});

Deno.test("getTargetAsset: unsupported platforms and arches map to null", () => {
  assertEquals(getTargetAsset("win32", "x64"), null);
  assertEquals(getTargetAsset("darwin", "ia32"), null);
  assertEquals(getTargetAsset("freebsd", "x64"), null);
  assertEquals(getTargetAsset("linux", "riscv64"), null);
});

Deno.test("normalizeArch canonicalizes known arches, rejects others", () => {
  assertEquals(normalizeArch("arm64"), "arm64");
  assertEquals(normalizeArch("aarch64"), "arm64");
  assertEquals(normalizeArch("x64"), "x86_64");
  assertEquals(normalizeArch("x86_64"), "x86_64");
  assertEquals(normalizeArch("ia32"), null);
});

Deno.test("getTargetKey builds platform-arch keys", () => {
  assertEquals(getTargetKey("darwin", "arm64"), "darwin-arm64");
  assertEquals(getTargetKey("linux", "x64"), "linux-x86_64");
  assertEquals(getTargetKey("win32", "x64"), null);
});

Deno.test("every returned asset is a real release asset name", () => {
  // Drift guard: the launcher and postinstall must only ever reference assets
  // that actually exist on the scout-v<version> release.
  const expected = [
    "scout-darwin-arm64",
    "scout-darwin-x86_64",
    "scout-linux-arm64",
    "scout-linux-x86_64",
  ];
  assertEquals([...SUPPORTED_ASSETS].sort(), [...expected].sort());

  for (const [platform, arch] of [
    ["darwin", "arm64"],
    ["darwin", "x64"],
    ["linux", "arm64"],
    ["linux", "x64"],
  ] as const) {
    const asset = getTargetAsset(platform, arch);
    assert(asset !== null && expected.includes(asset));
  }
});

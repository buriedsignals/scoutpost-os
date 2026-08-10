import { assert, assertFalse } from "jsr:@std/assert";

const config = JSON.parse(
  await Deno.readTextFile(new URL("../deno.json", import.meta.url)),
) as { tasks: Record<string, string> };

Deno.test("compiled binaries only allow the native browser opener", () => {
  for (const name of ["compile-mac-arm", "compile-mac-x86"]) {
    assert(config.tasks[name].includes("--allow-run=/usr/bin/open"));
    assertFalse(config.tasks[name].includes("xdg-open"));
  }

  for (const name of ["compile-linux-arm", "compile-linux-x86"]) {
    assert(config.tasks[name].includes("--allow-run=/usr/bin/xdg-open"));
    assertFalse(config.tasks[name].includes("/usr/bin/open"));
  }

  assert(config.tasks["compile-windows-x86"].includes("--allow-ffi"));
  assertFalse(config.tasks["compile-windows-x86"].includes("--allow-run"));
  assertFalse(config.tasks["compile-windows-x86"].includes("cmd.exe"));
  assertFalse(config.tasks["compile-windows-x86"].includes("/usr/bin/"));
});

import { assertEquals } from "jsr:@std/assert";
import { browserCommand, waitForBrowserProcess } from "./browser.ts";

Deno.test("browser launcher uses only the supported platform opener", () => {
  assertEquals(
    browserCommand("https://example.test", {
      os: "darwin",
      ssh: false,
      graphical: true,
    }),
    { command: "/usr/bin/open", args: ["https://example.test"] },
  );
  assertEquals(
    browserCommand("https://example.test", {
      os: "linux",
      ssh: false,
      graphical: true,
    }),
    { command: "/usr/bin/xdg-open", args: ["https://example.test"] },
  );
  assertEquals(
    browserCommand("https://example.test", {
      os: "windows",
      ssh: false,
      graphical: true,
    }),
    null,
  );
  assertEquals(
    browserCommand("https://example.test", {
      os: "linux",
      ssh: true,
      graphical: true,
    }),
    null,
  );
});

Deno.test("browser launcher times out and terminates a hung opener", async () => {
  let killed = false;
  let finish!: (status: Deno.CommandStatus) => void;
  const status = new Promise<Deno.CommandStatus>((resolve) => {
    finish = resolve;
  });
  const result = await waitForBrowserProcess({
    status,
    kill: () => {
      killed = true;
      finish({ success: false, code: 143, signal: "SIGTERM" });
    },
  }, 1);
  assertEquals(result, false);
  assertEquals(killed, true);
});

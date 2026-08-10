import { assertEquals } from "jsr:@std/assert";

import { configPath, readConfigFile, writeConfigFile } from "./client.ts";
import { WindowsCredentialStore } from "./windows_credentials.ts";

Deno.test({
  name: "Windows Credential Manager current-user round trip",
  ignore: Deno.build.os !== "windows" ||
    Deno.env.get("SCOUT_WINDOWS_CREDENTIAL_LIVE_TEST") !== "1",
  fn: () => {
    const store = new WindowsCredentialStore(
      `IndicatorLabs/ScoutpostTest/${crypto.randomUUID()}`,
    );
    const key = "api_key";
    const value = `cj_test_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      store.set(key, value);
      assertEquals(store.get(key), value);
      store.delete(key);
      assertEquals(store.get(key), undefined);
    } finally {
      store.delete(key);
    }
  },
});

Deno.test({
  name: "Windows config lifecycle keeps credentials out of AppData JSON",
  ignore: Deno.build.os !== "windows" ||
    Deno.env.get("SCOUT_WINDOWS_CREDENTIAL_LIVE_TEST") !== "1",
  fn: async () => {
    const originalAppData = Deno.env.get("APPDATA");
    const appData = await Deno.makeTempDir({ prefix: "scout-windows-config-" });
    const store = new WindowsCredentialStore(
      `IndicatorLabs/ScoutpostTest/${crypto.randomUUID()}`,
    );
    Deno.env.set("APPDATA", appData);
    try {
      writeConfigFile({
        api_url: "https://example.test/functions/v1",
        api_key: "cj_windows_live_secret_123456789",
      }, store);
      const first = readConfigFile(store);
      assertEquals(first.api_key, "cj_windows_live_secret_123456789");
      assertEquals(
        Deno.readTextFileSync(configPath()).includes("windows_live_secret"),
        false,
      );

      writeConfigFile(
        { ...first, api_url: "https://updated.example.test" },
        store,
      );
      assertEquals(
        readConfigFile(store).api_url,
        "https://updated.example.test",
      );
      writeConfigFile({ api_url: "https://updated.example.test" }, store);
      assertEquals(store.get("api_key"), undefined);
    } finally {
      store.delete("api_key");
      store.delete("auth_token");
      if (originalAppData === undefined) Deno.env.delete("APPDATA");
      else Deno.env.set("APPDATA", originalAppData);
      await Deno.remove(appData, { recursive: true });
    }
  },
});

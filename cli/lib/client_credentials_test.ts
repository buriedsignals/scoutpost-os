import {
  assertEquals,
  assertStrictEquals,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert";

import {
  configDir,
  configPath,
  type CredentialStore,
  readConfigFile,
  withRuntimeCredential,
  writeConfigFile,
} from "./client.ts";

class FakeCredentialStore implements CredentialStore {
  readonly values = new Map<string, string>();
  failOnGet: string | null = null;
  failOnSet: string | null = null;

  get(key: string): string | undefined {
    if (key === this.failOnGet) {
      throw new Error("injected credential-read failure");
    }
    return this.values.get(key);
  }

  set(key: string, value: string): void {
    if (key === this.failOnSet) {
      this.failOnSet = null;
      throw new Error("injected credential-store failure");
    }
    this.values.set(key, value);
  }

  delete(key: string): void {
    this.values.delete(key);
  }
}

async function withTempHome(fn: () => void | Promise<void>): Promise<void> {
  const original = Deno.env.get("HOME");
  const originalAppData = Deno.env.get("APPDATA");
  const temporary = await Deno.makeTempDir({ prefix: "scout-credentials-" });
  Deno.env.set("HOME", temporary);
  Deno.env.set("APPDATA", temporary);
  try {
    await fn();
  } finally {
    if (original === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", original);
    if (originalAppData === undefined) Deno.env.delete("APPDATA");
    else Deno.env.set("APPDATA", originalAppData);
    await Deno.remove(temporary, { recursive: true });
  }
}

Deno.test("Windows config path uses APPDATA instead of assuming HOME", () => {
  const env = {
    get: (name: string) =>
      name === "APPDATA" ? "C:\\Users\\Reporter\\AppData\\Roaming" : undefined,
  };
  assertEquals(
    configDir("windows", env),
    "C:\\Users\\Reporter\\AppData\\Roaming\\Scoutpost",
  );
  assertEquals(
    configPath("windows", env),
    "C:\\Users\\Reporter\\AppData\\Roaming\\Scoutpost\\config.json",
  );
});

Deno.test("runtime credential overlays hosted public config without mutating it", () => {
  const publicConfig = {
    api_url: "https://scoutpost.ai/functions/v1/",
    supabase_anon_key: "public-gateway-value",
  };
  const resolved = withRuntimeCredential(publicConfig, {
    get: (name: string) => {
      if (name === "SCOUTPOST_API_KEY") return "cj_runtime-only";
      if (name === "SCOUTPOST_API_KEY_AUDIENCE") {
        return "https://scoutpost.ai/functions/v1";
      }
      return undefined;
    },
  });

  assertEquals(resolved.api_key, "cj_runtime-only");
  assertEquals(publicConfig, {
    api_url: "https://scoutpost.ai/functions/v1/",
    supabase_anon_key: "public-gateway-value",
  });
});

Deno.test("ambient API key without an audience marker preserves existing config", () => {
  const config = {
    api_url: "https://self-hosted.example/functions/v1",
    api_key: "cj_configured",
  };
  const resolved = withRuntimeCredential(config, {
    get: (name: string) =>
      name === "SCOUTPOST_API_KEY" ? "cj_ambient" : undefined,
  });

  assertStrictEquals(resolved, config);
  assertEquals(resolved.api_key, "cj_configured");
});

Deno.test("runtime credential requires a valid key and exact hosted audience", () => {
  const hostedConfig = { api_url: "https://scoutpost.ai/functions/v1" };
  const runtimeEnv = (
    key: string | undefined,
    audience: string | undefined,
  ) => ({
    get: (name: string) => {
      if (name === "SCOUTPOST_API_KEY") return key;
      if (name === "SCOUTPOST_API_KEY_AUDIENCE") return audience;
      return undefined;
    },
  });

  assertThrows(
    () =>
      withRuntimeCredential(
        hostedConfig,
        runtimeEnv(undefined, hostedConfig.api_url),
      ),
    Error,
    "SCOUTPOST_API_KEY is invalid",
  );
  assertThrows(
    () =>
      withRuntimeCredential(
        hostedConfig,
        runtimeEnv("secret\nleak", hostedConfig.api_url),
      ),
    Error,
    "SCOUTPOST_API_KEY is invalid",
  );
  assertThrows(
    () =>
      withRuntimeCredential(
        hostedConfig,
        runtimeEnv("cj_runtime-only", "https://attacker.example"),
      ),
    Error,
    "SCOUTPOST_API_KEY audience is invalid",
  );
  assertThrows(
    () =>
      withRuntimeCredential(
        { api_url: "https://attacker.example" },
        runtimeEnv("cj_runtime-only", hostedConfig.api_url),
      ),
    Error,
    "not valid for the configured api_url",
  );
});

Deno.test("credential-backed config never writes secret fields to disk", async () => {
  await withTempHome(() => {
    const store = new FakeCredentialStore();
    writeConfigFile({
      api_url: "https://scoutpost.ai/functions/v1",
      api_key: "cj_secret-value",
      auth_token: "legacy-secret-value",
      supabase_anon_key: "public-gateway-value",
    }, store);

    const raw = Deno.readTextFileSync(configPath());
    assertEquals(raw.includes("cj_secret-value"), false);
    assertEquals(raw.includes("legacy-secret-value"), false);
    assertStringIncludes(raw, "public-gateway-value");

    const hydrated = readConfigFile(store);
    assertEquals(hydrated.api_key, "cj_secret-value");
    assertEquals(hydrated.auth_token, "legacy-secret-value");
    assertEquals(hydrated.api_url, "https://scoutpost.ai/functions/v1");
  });
});

Deno.test("plaintext Windows credential migration commits store before scrubbing disk", async () => {
  await withTempHome(() => {
    writeConfigFile({
      api_url: "https://example.test",
      api_key: "cj_old-plaintext",
    }, null);
    const store = new FakeCredentialStore();
    const hydrated = readConfigFile(store);
    assertEquals(hydrated.api_key, "cj_old-plaintext");
    assertEquals(store.get("api_key"), "cj_old-plaintext");
    assertEquals(
      Deno.readTextFileSync(configPath()).includes("cj_old-plaintext"),
      false,
    );
  });
});

Deno.test("credential transaction restores prior values when a write fails", async () => {
  await withTempHome(() => {
    const store = new FakeCredentialStore();
    store.set("api_key", "prior-api-key");
    store.set("auth_token", "prior-auth-token");
    store.failOnSet = "auth_token";
    let failed = false;
    try {
      writeConfigFile(
        { api_key: "new-api-key", auth_token: "new-auth-token" },
        store,
      );
    } catch {
      failed = true;
    }
    assertEquals(failed, true);
    assertEquals(store.get("api_key"), "prior-api-key");
    assertEquals(store.get("auth_token"), "prior-auth-token");
  });
});

Deno.test("credential snapshot failure performs no mutation", async () => {
  await withTempHome(() => {
    const store = new FakeCredentialStore();
    store.set("api_key", "prior-api-key");
    store.set("auth_token", "prior-auth-token");
    store.failOnGet = "auth_token";
    let failed = false;
    try {
      writeConfigFile(
        { api_key: "new-api-key", auth_token: "new-auth-token" },
        store,
      );
    } catch {
      failed = true;
    }
    assertEquals(failed, true);
    store.failOnGet = null;
    assertEquals(store.get("api_key"), "prior-api-key");
    assertEquals(store.get("auth_token"), "prior-auth-token");
  });
});

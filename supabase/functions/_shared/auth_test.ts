import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { internalServiceAuthHeaders, requireServiceKey } from "./auth.ts";
import { AuthError } from "./errors.ts";

const ENV_NAMES = [
  "INTERNAL_SERVICE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SERVICE_SUPABASE_SERVICE_ROLE_KEY",
  "SERVICE_ROLE_KEY",
] as const;

function withEnv(values: Record<string, string | undefined>, fn: () => void) {
  const previous = new Map<string, string | undefined>();
  for (const name of ENV_NAMES) {
    previous.set(name, Deno.env.get(name));
    Deno.env.delete(name);
  }
  try {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
    fn();
  } finally {
    for (const [name, value] of previous.entries()) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
}

Deno.test("requireServiceKey accepts X-Service-Key internal secret", () => {
  withEnv({ INTERNAL_SERVICE_KEY: "internal-secret" }, () => {
    const req = new Request("https://example.test", {
      headers: { "X-Service-Key": "internal-secret" },
    });
    requireServiceKey(req);
  });
});

Deno.test("requireServiceKey accepts service-role bearer fallback", () => {
  withEnv({ SUPABASE_SERVICE_ROLE_KEY: "service-role-secret" }, () => {
    const req = new Request("https://example.test", {
      headers: { Authorization: "Bearer service-role-secret" },
    });
    requireServiceKey(req);
  });
});

Deno.test("requireServiceKey rejects bad service key", () => {
  withEnv({
    INTERNAL_SERVICE_KEY: "internal-secret",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
  }, () => {
    const req = new Request("https://example.test", {
      headers: { "X-Service-Key": "wrong-secret" },
    });
    assertThrows(
      () => requireServiceKey(req),
      AuthError,
      "invalid service key",
    );
  });
});

Deno.test("internalServiceAuthHeaders prefers X-Service-Key", () => {
  withEnv({
    INTERNAL_SERVICE_KEY: "internal-secret",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
  }, () => {
    assertEquals(internalServiceAuthHeaders(), {
      "X-Service-Key": "internal-secret",
    });
  });
});

Deno.test("internalServiceAuthHeaders falls back to service-role bearer", () => {
  withEnv({ SUPABASE_SERVICE_ROLE_KEY: "service-role-secret" }, () => {
    assertEquals(internalServiceAuthHeaders(), {
      "Authorization": "Bearer service-role-secret",
    });
  });
});

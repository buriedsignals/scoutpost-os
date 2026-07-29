import {
  assertEquals,
  assertMatch,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const enabled = Deno.env.get("SCOUT_CLI_AUTH_RUNTIME_SMOKE") === "1";

Deno.test({
  name: "local device flow creates, validates, and self-revokes one key",
  ignore: !enabled,
  async fn() {
    const apiUrl = requiredEnv("API_URL", "SUPABASE_URL").replace(/\/$/, "");
    const anonKey = requiredEnv("ANON_KEY", "SUPABASE_ANON_KEY");
    const serviceKey = requiredEnv(
      "SERVICE_ROLE_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
    );
    const host = new URL(apiUrl).hostname;
    if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
      throw new Error(
        "CLI auth runtime smoke refuses non-local Supabase targets",
      );
    }

    const email = `cli-auth-${crypto.randomUUID()}@example.test`;
    const password = `A-${crypto.randomUUID()}!`;
    let userId = "";
    try {
      const created = await jsonFetch(`${apiUrl}/auth/v1/admin/users`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serviceKey}`,
          apikey: serviceKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email, password, email_confirm: true }),
      });
      userId = String(created.id);

      const session = await jsonFetch(
        `${apiUrl}/auth/v1/token?grant_type=password`,
        {
          method: "POST",
          headers: { apikey: anonKey, "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        },
      );
      const accessToken = String(session.access_token);
      const siteOrigin = "http://127.0.0.1:5173";
      const edgeHeaders = {
        apikey: anonKey,
        "Content-Type": "application/json",
      };

      const device = await jsonFetch(
        `${apiUrl}/functions/v1/cli-auth/v1/device/authorize`,
        {
          method: "POST",
          headers: edgeHeaders,
          body: JSON.stringify({
            client_name: "Scout CLI",
            agent_label: "Runtime Smoke",
            site_origin: siteOrigin,
          }),
        },
      );
      assertMatch(
        String(device.user_code),
        /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/,
      );

      const approved = await jsonFetch(
        `${apiUrl}/functions/v1/cli-auth/v1/device/approve`,
        {
          method: "POST",
          headers: {
            ...edgeHeaders,
            Authorization: `Bearer ${accessToken}`,
            Origin: siteOrigin,
          },
          body: JSON.stringify({ user_code: device.user_code }),
        },
      );
      assertEquals(approved.status, "approved");

      const tokenRequests = await Promise.all(
        [0, 1].map(() =>
          fetch(`${apiUrl}/functions/v1/cli-auth/v1/device/token`, {
            method: "POST",
            headers: edgeHeaders,
            body: JSON.stringify({
              grant_type: "urn:ietf:params:oauth:grant-type:device_code",
              device_code: device.device_code,
            }),
          })
        ),
      );
      const tokenBodies = await Promise.all(
        tokenRequests.map(async (response) => ({
          status: response.status,
          body: await response.json().catch(() => ({})) as Record<
            string,
            unknown
          >,
        })),
      );
      const successes = tokenBodies.filter(({ status }) => status === 200);
      const failures = tokenBodies.filter(({ status }) => status !== 200);
      assertEquals(successes.length, 1);
      assertEquals(failures.length, 1);
      assertEquals(failures[0].body.code, "invalid_grant");

      const token = successes[0].body;
      const apiKey = String(token.api_key);
      assertMatch(apiKey, /^cj_[A-Za-z0-9_-]{20,}$/);
      assertEquals(JSON.stringify(failures[0].body).includes(apiKey), false);
      assertEquals(
        JSON.stringify(failures[0].body).includes(String(device.device_code)),
        false,
      );

      const authenticated = await fetch(
        `${apiUrl}/functions/v1/user/me`,
        {
          headers: { apikey: anonKey, Authorization: `Bearer ${apiKey}` },
        },
      );
      assertEquals(authenticated.status, 200);
      await authenticated.body?.cancel();

      const revoked = await fetch(
        `${apiUrl}/functions/v1/api-keys/self`,
        {
          method: "DELETE",
          headers: { apikey: anonKey, Authorization: `Bearer ${apiKey}` },
        },
      );
      assertEquals(revoked.status, 204);
      await revoked.body?.cancel();

      const rejected = await fetch(
        `${apiUrl}/functions/v1/user/me`,
        {
          headers: { apikey: anonKey, Authorization: `Bearer ${apiKey}` },
        },
      );
      assertEquals(rejected.status, 401);
      await rejected.body?.cancel();
    } finally {
      if (userId) {
        const deleted = await fetch(`${apiUrl}/auth/v1/admin/users/${userId}`, {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${serviceKey}`,
            apikey: serviceKey,
          },
        });
        await deleted.body?.cancel();
      }
    }
  },
});

function requiredEnv(...names: string[]): string {
  for (const name of names) {
    const value = Deno.env.get(name);
    if (value) return value;
  }
  throw new Error(`Missing local test env: ${names.join(" or ")}`);
}

async function jsonFetch(
  url: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({})) as Record<
    string,
    unknown
  >;
  if (!response.ok) {
    throw new Error(`Local runtime request failed: HTTP ${response.status}`);
  }
  return body;
}

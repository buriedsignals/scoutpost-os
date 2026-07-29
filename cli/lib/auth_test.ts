import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert";
import {
  DEVICE_GRANT_TYPE,
  fetchDiscovery,
  login,
  logout,
  normalizeSite,
  readBoundedObject,
  status,
} from "./auth.ts";
import type { Config } from "./client.ts";

const SITE = "https://newsroom.example";
const API = "https://api.newsroom.example/functions/v1";
const DEVICE_SECRET = "device_code_secret_that_must_never_be_printed_123";
const API_SECRET = "cj_SUPERSECRET012345678901234";

function discovery() {
  return {
    version: 1,
    issuer: SITE,
    api_origin: "https://api.newsroom.example",
    api_base_url: API,
    device_authorization_endpoint:
      "https://api.newsroom.example/functions/v1/cli-auth/v1/device/authorize",
    token_endpoint:
      "https://api.newsroom.example/functions/v1/cli-auth/v1/device/token",
    verification_uri: `${SITE}/cli/authorize`,
    api_key_management_url: `${SITE}/?connect=api`,
    public_gateway_key: "public-anon-key",
  };
}

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

Deno.test("site validation permits HTTPS and loopback HTTP only", () => {
  assertEquals(
    normalizeSite("https://scoutpost.ai").origin,
    "https://scoutpost.ai",
  );
  assertEquals(
    normalizeSite("http://localhost:5173").origin,
    "http://localhost:5173",
  );
  assertThrows(
    () => normalizeSite("http://newsroom.example"),
    Error,
    "HTTPS",
  );
  assertThrows(
    () => normalizeSite("https://user@newsroom.example/path"),
    Error,
    "origin",
  );
});

Deno.test("chunked responses are rejected before exceeding the byte cap", async () => {
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(32_000));
        controller.enqueue(new Uint8Array(32_001));
        controller.close();
      },
    }),
  );

  await assertRejects(
    () => readBoundedObject(response),
    Error,
    "Authentication request failed (200).",
  );
});

Deno.test("discovery permits only the declared site/API origin pair", async () => {
  const good = await fetchDiscovery(
    SITE,
    () => Promise.resolve(json(discovery())),
  );
  assertEquals(good.api_base_url, API);

  await assertRejects(
    () =>
      fetchDiscovery(SITE, () =>
        Promise.resolve(json({
          ...discovery(),
          token_endpoint: "https://evil.example/token",
        }))),
    Error,
    "untrusted token_endpoint",
  );
  await assertRejects(
    () =>
      fetchDiscovery(SITE, () =>
        Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { Location: "https://evil.example" },
          }),
        )),
    Error,
    "redirects",
  );
});

Deno.test("login handles browser fallback, polling, and never prints either secret", async () => {
  let config: Config = {};
  let now = 0;
  let tokenPolls = 0;
  let launched = "";
  const output: string[] = [];
  const writes: Config[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = String(input);
    if (url.endsWith("/.well-known/scoutpost-cli.json")) {
      return Promise.resolve(json(discovery()));
    }
    if (url.endsWith("/device/authorize")) {
      return Promise.resolve(json({
        device_code: DEVICE_SECRET,
        user_code: "ABCD-2345",
        verification_uri: `${SITE}/cli/authorize`,
        verification_uri_complete: `${SITE}/cli/authorize?user_code=ABCD-2345`,
        expires_in: 600,
        interval: 5,
      }, 201));
    }
    if (url.endsWith("/device/token")) {
      tokenPolls++;
      const requestInit = init as globalThis.RequestInit | undefined;
      const body = JSON.parse(String(requestInit?.body));
      assertEquals(body.grant_type, DEVICE_GRANT_TYPE);
      assertEquals(body.device_code, DEVICE_SECRET);
      if (tokenPolls === 1) {
        return Promise.resolve(json({
          error: "authorization_pending",
          code: "authorization_pending",
        }, 400));
      }
      return Promise.resolve(json({
        token_type: "api_key",
        api_key: API_SECRET,
        key_id: "11111111-1111-1111-1111-111111111111",
        key_prefix: "cj_SUPERSEC",
        name: "Claude Code",
        account: { user_id: "user-1", email: "reporter@example.com" },
      }));
    }
    if (url.endsWith("/user/me")) {
      assertStringIncludes(
        new Headers((init as globalThis.RequestInit | undefined)?.headers).get(
          "Authorization",
        ) ?? "",
        API_SECRET,
      );
      return Promise.resolve(json({
        user_id: "user-1",
        email: "reporter@example.com",
      }));
    }
    throw new Error(`unexpected URL ${url}`);
  };

  await login({ site: SITE, label: "Claude Code" }, {
    fetch: fetchImpl,
    now: () => now,
    sleep: (milliseconds) => {
      now += milliseconds;
      return Promise.resolve();
    },
    launchBrowser: (url) => {
      launched = url;
      return Promise.resolve(false);
    },
    readConfig: () => config,
    writeConfig: (next) => {
      config = next;
      writes.push(next);
    },
    log: (message) => output.push(message),
    warn: (message) => output.push(message),
  });

  assertEquals(tokenPolls, 2);
  assertEquals(writes.length, 1);
  assertEquals(config.api_key, API_SECRET);
  assertEquals(config.site_url, SITE);
  assertEquals(launched, `${SITE}/cli/authorize?user_code=ABCD-2345`);
  const visible = output.join("\n") + launched;
  assertEquals(visible.includes(DEVICE_SECRET), false);
  assertEquals(visible.includes(API_SECRET), false);
  assertStringIncludes(visible, "reporter@example.com");
  assertStringIncludes(visible, "Could not open a browser");
});

Deno.test("denied, expired, and key-limited requests stop without writing config", async () => {
  const cases = [
    {
      code: "access_denied",
      message: "denied",
    },
    {
      code: "expired_token",
      message: "expired",
    },
    {
      code: "api_key_limit_reached",
      message: "API key limit reached",
    },
  ];

  for (const testCase of cases) {
    let now = 0;
    let writes = 0;
    const fetchImpl: typeof fetch = (input) => {
      const url = String(input);
      if (url.endsWith("/.well-known/scoutpost-cli.json")) {
        return Promise.resolve(json(discovery()));
      }
      if (url.endsWith("/device/authorize")) {
        return Promise.resolve(json({
          device_code: DEVICE_SECRET,
          user_code: "ABCD-2345",
          verification_uri: `${SITE}/cli/authorize`,
          verification_uri_complete:
            `${SITE}/cli/authorize?user_code=ABCD-2345`,
          expires_in: 600,
          interval: 5,
        }, 201));
      }
      if (url.endsWith("/device/token")) {
        return Promise.resolve(json({
          error: testCase.code,
          code: testCase.code,
        }, 400));
      }
      throw new Error(`unexpected URL ${url}`);
    };

    await assertRejects(
      () =>
        login({ site: SITE, label: "Codex" }, {
          fetch: fetchImpl,
          now: () => now,
          sleep: (milliseconds) => {
            now += milliseconds;
            return Promise.resolve();
          },
          launchBrowser: () => Promise.resolve(false),
          readConfig: () => ({}),
          writeConfig: () => writes++,
          log: () => {},
          warn: () => {},
        }),
      Error,
      testCase.message,
    );
    assertEquals(writes, 0);
  }
});

Deno.test("credential response rejects an unsafe or non-matching key prefix", async () => {
  for (const keyPrefix of [API_SECRET, "cj_BAD\u001b[31m"]) {
    let now = 0;
    let writes = 0;
    let revokes = 0;
    await assertRejects(
      () =>
        login({ site: SITE, label: "Codex" }, {
          fetch: (input) => {
            const url = String(input);
            if (url.endsWith("/.well-known/scoutpost-cli.json")) {
              return Promise.resolve(json(discovery()));
            }
            if (url.endsWith("/device/authorize")) {
              return Promise.resolve(json({
                device_code: DEVICE_SECRET,
                user_code: "ABCD-2345",
                verification_uri: `${SITE}/cli/authorize`,
                verification_uri_complete:
                  `${SITE}/cli/authorize?user_code=ABCD-2345`,
                expires_in: 600,
                interval: 1,
              }, 201));
            }
            if (url.endsWith("/device/token")) {
              return Promise.resolve(json({
                token_type: "api_key",
                api_key: API_SECRET,
                key_id: "key-1",
                key_prefix: keyPrefix,
                name: "Scout CLI · Codex",
                account: { user_id: "user-1" },
              }));
            }
            if (url.endsWith("/api-keys/self")) {
              revokes++;
              return Promise.resolve(new Response(null, { status: 204 }));
            }
            throw new Error(`unexpected ${url}`);
          },
          now: () => now,
          sleep: (milliseconds) => {
            now += milliseconds;
            return Promise.resolve();
          },
          launchBrowser: () => Promise.resolve(false),
          readConfig: () => ({}),
          writeConfig: () => writes++,
          log: () => {},
          warn: () => {},
        }),
      Error,
      "invalid credential",
    );
    assertEquals(writes, 0);
    assertEquals(revokes, 1);
  }
});

Deno.test("untrusted server errors never reflect response secrets", async () => {
  let now = 0;
  const fetchImpl: typeof fetch = (input) => {
    const url = String(input);
    if (url.endsWith("/.well-known/scoutpost-cli.json")) {
      return Promise.resolve(json(discovery()));
    }
    if (url.endsWith("/device/authorize")) {
      return Promise.resolve(json({
        device_code: DEVICE_SECRET,
        user_code: "ABCD-2345",
        verification_uri: `${SITE}/cli/authorize`,
        verification_uri_complete: `${SITE}/cli/authorize?user_code=ABCD-2345`,
        expires_in: 600,
        interval: 5,
      }, 201));
    }
    if (url.endsWith("/device/token")) {
      return Promise.resolve(json({
        error: `${DEVICE_SECRET}:${API_SECRET}`,
        detail: `${DEVICE_SECRET}:${API_SECRET}`,
      }, 500));
    }
    throw new Error(`unexpected URL ${url}`);
  };

  const error = await assertRejects(
    () =>
      login({ site: SITE, label: "Codex" }, {
        fetch: fetchImpl,
        now: () => now,
        sleep: (milliseconds) => {
          now += milliseconds;
          return Promise.resolve();
        },
        launchBrowser: () => Promise.resolve(false),
        readConfig: () => ({}),
        log: () => {},
        warn: () => {},
      }),
  );
  const message = error instanceof Error ? error.message : String(error);
  assertEquals(message.includes(DEVICE_SECRET), false);
  assertEquals(message.includes(API_SECRET), false);
  assertStringIncludes(message, "HTTP 500");
});

Deno.test("valid existing login creates no device request", async () => {
  let deviceRequests = 0;
  const output: string[] = [];
  await login({ site: SITE, label: "Codex" }, {
    fetch: (input) => {
      const url = String(input);
      if (url.endsWith("/.well-known/scoutpost-cli.json")) {
        return Promise.resolve(json(discovery()));
      }
      if (url.endsWith("/user/me")) {
        return Promise.resolve(json({ user_id: "user-1" }));
      }
      deviceRequests++;
      throw new Error("device request should not happen");
    },
    readConfig: () => ({
      site_url: SITE,
      api_url: API,
      api_key: API_SECRET,
    }),
    log: (message) => output.push(message),
  });
  assertEquals(deviceRequests, 0);
  assertStringIncludes(output.join("\n"), "Already authenticated");
});

Deno.test("switch protection preserves the existing config", async () => {
  const existing: Config = {
    site_url: "https://other.example",
    api_url: "https://other.example/functions/v1",
    api_key: "cj_existing_existing_existing",
  };
  let writes = 0;
  await assertRejects(
    () =>
      login({ site: SITE, label: "Codex" }, {
        fetch: (input) => {
          if (String(input).endsWith("/.well-known/scoutpost-cli.json")) {
            return Promise.resolve(json(discovery()));
          }
          throw new Error("unexpected");
        },
        readConfig: () => existing,
        writeConfig: () => writes++,
      }),
    Error,
    "--switch",
  );
  assertEquals(writes, 0);
});

Deno.test("legacy credentials require an explicit switch when target is unknown", async () => {
  let deviceRequests = 0;
  await assertRejects(
    () =>
      login({ site: SITE, label: "Codex" }, {
        fetch: (input) => {
          if (String(input).endsWith("/.well-known/scoutpost-cli.json")) {
            return Promise.resolve(json(discovery()));
          }
          deviceRequests++;
          throw new Error("must not create a device request");
        },
        readConfig: () => ({
          api_url: "https://legacy.example/functions/v1",
          api_key: API_SECRET,
        }),
      }),
    Error,
    "--switch",
  );
  assertEquals(deviceRequests, 0);
});

Deno.test("transient existing-credential validation never mints another key", async () => {
  for (const statusCode of [403, 503]) {
    let deviceRequests = 0;
    await assertRejects(
      () =>
        login({ site: SITE, label: "Codex" }, {
          fetch: (input) => {
            const url = String(input);
            if (url.endsWith("/.well-known/scoutpost-cli.json")) {
              return Promise.resolve(json(discovery()));
            }
            if (url.endsWith("/user/me")) {
              return Promise.resolve(
                json({ code: "unavailable" }, statusCode),
              );
            }
            deviceRequests++;
            throw new Error("must not create a device request");
          },
          readConfig: () => ({
            site_url: SITE,
            api_url: API,
            api_key: API_SECRET,
          }),
        }),
      Error,
      `HTTP ${statusCode}`,
    );
    assertEquals(deviceRequests, 0);
  }
});

Deno.test("authentication requests have a bounded transport timeout", async () => {
  const abortingFetch: typeof fetch = (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = (init as globalThis.RequestInit | undefined)?.signal;
      signal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
      );
    });

  await assertRejects(
    () =>
      login({ site: SITE, label: "Codex" }, {
        fetch: abortingFetch,
        requestTimeoutMs: 1,
      }),
    Error,
    "timed out",
  );
});

Deno.test("authentication timeout includes a response body that stalls", async () => {
  const stalled = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"version":'));
    },
  });

  await assertRejects(
    () =>
      fetchDiscovery(
        SITE,
        () =>
          Promise.resolve(
            new Response(stalled, {
              headers: { "Content-Type": "application/json" },
            }),
          ),
        5,
      ),
    Error,
    "timed out",
  );
});

Deno.test("device polling retries only a bounded number of transport failures", async () => {
  let now = 0;
  let polls = 0;
  await assertRejects(
    () =>
      login({ site: SITE, label: "Codex" }, {
        fetch: (input) => {
          const url = String(input);
          if (url.endsWith("/.well-known/scoutpost-cli.json")) {
            return Promise.resolve(json(discovery()));
          }
          if (url.endsWith("/device/authorize")) {
            return Promise.resolve(json({
              device_code: DEVICE_SECRET,
              user_code: "ABCD-2345",
              verification_uri: `${SITE}/cli/authorize`,
              verification_uri_complete:
                `${SITE}/cli/authorize?user_code=ABCD-2345`,
              expires_in: 600,
              interval: 1,
            }, 201));
          }
          if (url.endsWith("/device/token")) {
            polls += 1;
            return Promise.reject(new Error(API_SECRET));
          }
          throw new Error(`unexpected ${url}`);
        },
        now: () => now,
        sleep: (milliseconds) => {
          now += milliseconds;
          return Promise.resolve();
        },
        launchBrowser: () => Promise.resolve(false),
        readConfig: () => ({}),
        log: () => {},
        warn: () => {},
      }),
    Error,
    "could not be reached",
  );
  assertEquals(polls, 3);
});

Deno.test("failed post-mint verification reports failed revocation safely", async () => {
  let now = 0;
  await assertRejects(
    () =>
      login({ site: SITE, label: "Codex" }, {
        fetch: (input) => {
          const url = String(input);
          if (url.endsWith("/.well-known/scoutpost-cli.json")) {
            return Promise.resolve(json(discovery()));
          }
          if (url.endsWith("/device/authorize")) {
            return Promise.resolve(json({
              device_code: DEVICE_SECRET,
              user_code: "ABCD-2345",
              verification_uri: `${SITE}/cli/authorize`,
              verification_uri_complete:
                `${SITE}/cli/authorize?user_code=ABCD-2345`,
              expires_in: 600,
              interval: 1,
            }, 201));
          }
          if (url.endsWith("/device/token")) {
            return Promise.resolve(json({
              token_type: "api_key",
              api_key: API_SECRET,
              key_id: "key-1",
              key_prefix: "cj_SUPERSEC",
              name: "Scout CLI · Codex",
              account: { user_id: "user-1" },
            }));
          }
          if (url.endsWith("/user/me")) {
            return Promise.resolve(json({ code: "unavailable" }, 503));
          }
          if (url.endsWith("/api-keys/self")) {
            return Promise.resolve(json({ code: "unavailable" }, 503));
          }
          throw new Error(`unexpected ${url}`);
        },
        now: () => now,
        sleep: (milliseconds) => {
          now += milliseconds;
          return Promise.resolve();
        },
        launchBrowser: () => Promise.resolve(false),
        readConfig: () => ({}),
        log: () => {},
        warn: () => {},
      }),
    Error,
    `Revoke cj_SUPERSEC… at ${SITE}/?connect=api`,
  );
});

Deno.test("failed config write reports an active credential when cleanup fails", async () => {
  let now = 0;
  await assertRejects(
    () =>
      login({ site: SITE, label: "Codex" }, {
        fetch: (input) => {
          const url = String(input);
          if (url.endsWith("/.well-known/scoutpost-cli.json")) {
            return Promise.resolve(json(discovery()));
          }
          if (url.endsWith("/device/authorize")) {
            return Promise.resolve(json({
              device_code: DEVICE_SECRET,
              user_code: "ABCD-2345",
              verification_uri: `${SITE}/cli/authorize`,
              verification_uri_complete:
                `${SITE}/cli/authorize?user_code=ABCD-2345`,
              expires_in: 600,
              interval: 1,
            }, 201));
          }
          if (url.endsWith("/device/token")) {
            return Promise.resolve(json({
              token_type: "api_key",
              api_key: API_SECRET,
              key_id: "key-1",
              key_prefix: "cj_SUPERSEC",
              name: "Scout CLI · Codex",
              account: { user_id: "user-1" },
            }));
          }
          if (url.endsWith("/user/me")) {
            return Promise.resolve(
              json({ user_id: "user-1", email: "reporter@example.com" }),
            );
          }
          if (url.endsWith("/api-keys/self")) {
            return Promise.resolve(json({ code: "unavailable" }, 503));
          }
          throw new Error(`unexpected ${url}`);
        },
        now: () => now,
        sleep: (milliseconds) => {
          now += milliseconds;
          return Promise.resolve();
        },
        launchBrowser: () => Promise.resolve(false),
        readConfig: () => ({}),
        writeConfig: () => {
          throw new Error("disk failure");
        },
        log: () => {},
        warn: () => {},
      }),
    Error,
    `Revoke cj_SUPERSEC… at ${SITE}/?connect=api`,
  );
});

Deno.test("status is redacted and logout clears both credential types", async () => {
  let config: Config = {
    site_url: SITE,
    api_url: API,
    api_key: API_SECRET,
    auth_token: "legacy-secret",
    api_key_prefix: "cj_SUPERSEC",
    api_key_name: "Codex",
    account_user_id: "user-1",
  };
  const output: string[] = [];
  const fetchImpl: typeof fetch = (input) => {
    const url = String(input);
    if (url.endsWith("/.well-known/scoutpost-cli.json")) {
      return Promise.resolve(json(discovery()));
    }
    if (url.endsWith("/user/me")) {
      return Promise.resolve(json({ user_id: "user-1" }));
    }
    if (url.endsWith("/api-keys/self")) {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    throw new Error(`unexpected ${url}`);
  };
  const common = {
    fetch: fetchImpl,
    readConfig: () => config,
    writeConfig: (next: Config) => {
      config = next;
    },
    log: (message: string) => output.push(message),
    warn: (message: string) => output.push(message),
  };
  await status(undefined, common);
  await logout(common);
  assertEquals(config.api_key, undefined);
  assertEquals(config.auth_token, undefined);
  assertEquals(config.api_url, API);
  const visible = output.join("\n");
  assertEquals(visible.includes(API_SECRET), false);
  assertEquals(visible.includes("legacy-secret"), false);
  assertStringIncludes(visible, "revoked");
});

Deno.test("status never sends an active credential to a different site", async () => {
  let requests = 0;
  await assertRejects(
    () =>
      status("https://evil.example", {
        fetch: () => {
          requests++;
          throw new Error("must not fetch");
        },
        readConfig: () => ({
          site_url: SITE,
          api_url: API,
          api_key: API_SECRET,
        }),
      }),
    Error,
    "different site",
  );
  assertEquals(requests, 0);
});

Deno.test("legacy status verifies its configured API before sending a credential", async () => {
  let credentialRequests = 0;
  await assertRejects(
    () =>
      status(SITE, {
        fetch: (input, init) => {
          if (String(input).endsWith("/.well-known/scoutpost-cli.json")) {
            return Promise.resolve(json(discovery()));
          }
          const requestHeaders =
            (init as { headers?: ConstructorParameters<typeof Headers>[0] })
              ?.headers;
          if (new Headers(requestHeaders).has("authorization")) {
            credentialRequests++;
          }
          throw new Error("credential must not be sent");
        },
        readConfig: () => ({
          api_url: "https://other.example/functions/v1",
          api_key: API_SECRET,
        }),
      }),
    Error,
    "different API",
  );
  assertEquals(credentialRequests, 0);
});

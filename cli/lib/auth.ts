import { type Config, readConfigFile, writeConfigFile } from "./client.ts";
import { launchBrowser as launchSystemBrowser } from "./browser.ts";

export const DEFAULT_SITE = "https://scoutpost.ai";
export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_TRANSIENT_POLL_FAILURES = 3;

export interface Discovery {
  version: 1;
  issuer: string;
  api_origin: string;
  api_base_url: string;
  device_authorization_endpoint: string;
  token_endpoint: string;
  verification_uri: string;
  api_key_management_url: string;
  public_gateway_key?: string;
}

interface Account {
  user_id: string;
  email?: string | null;
}

interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface TokenSuccess {
  token_type: "api_key";
  api_key: string;
  key_id: string;
  key_prefix: string;
  name: string;
  account: Account;
}

export interface AuthDependencies {
  fetch: typeof fetch;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => number;
  requestTimeoutMs: number;
  launchBrowser: (url: string) => Promise<boolean>;
  readConfig: () => Config;
  writeConfig: (config: Config) => void;
  log: (message: string) => void;
  warn: (message: string) => void;
}

const defaultDeps: AuthDependencies = {
  fetch,
  sleep: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now: Date.now,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  launchBrowser: launchSystemBrowser,
  readConfig: readConfigFile,
  writeConfig: writeConfigFile,
  log: console.log,
  warn: console.error,
};

function depsWith(overrides: Partial<AuthDependencies>): AuthDependencies {
  return { ...defaultDeps, ...overrides };
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: string | URL | Request,
  init: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const response = await fetchImpl(input, {
      ...init,
      signal: controller.signal,
    });
    const text = await readBoundedResponseText(
      response,
      64_000,
      controller.signal,
    );
    const body = response.status === 204 || response.status === 205 ||
        response.status === 304
      ? null
      : text;
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("Authentication request timed out. Try again.");
    }
    if (
      error instanceof Error &&
      error.message.startsWith("Authentication request failed")
    ) {
      throw error;
    }
    throw new Error("Authentication service could not be reached. Try again.");
  } finally {
    clearTimeout(timer);
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "::1" ||
    hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function requireSecure(url: URL): void {
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && isLoopback(url.hostname)) return;
  throw new Error(
    "Scoutpost site must use HTTPS (HTTP is allowed only on loopback).",
  );
}

export function normalizeSite(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid Scoutpost site URL.");
  }
  requireSecure(url);
  if (
    url.username || url.password || url.search || url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error(
      "Scoutpost site must be an origin without a path, query, or credentials.",
    );
  }
  return new URL(url.origin);
}

function endpoint(
  value: unknown,
  allowedOrigins: Set<string>,
  name: string,
  base: URL,
): string {
  if (typeof value !== "string") {
    throw new Error(`Discovery is missing ${name}.`);
  }
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    throw new Error(`Discovery contains an invalid ${name}.`);
  }
  requireSecure(url);
  if (
    url.username || url.password || url.hash || !allowedOrigins.has(url.origin)
  ) {
    throw new Error(`Discovery contains an untrusted ${name}.`);
  }
  return url.toString().replace(/\/$/, "");
}

async function safeJson(
  response: Response,
  allowedCodes: ReadonlySet<string>,
): Promise<Record<string, unknown>> {
  const data = await readBoundedObject(response);
  if (!response.ok) {
    const code = typeof data.code === "string"
      ? data.code
      : typeof data.error === "string"
      ? data.error
      : "";
    const safeCode = allowedCodes.has(code) ? ` (${code})` : "";
    throw new Error(
      `Authentication request failed: HTTP ${response.status}${safeCode}.`,
    );
  }
  return data;
}

export async function readBoundedObject(
  response: Response,
): Promise<Record<string, unknown>> {
  const text = await readBoundedResponseText(response, 64_000);
  let data: Record<string, unknown> = {};
  try {
    const parsed = text ? JSON.parse(text) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    // Never echo arbitrary server bodies.
  }
  return data;
}

async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = signal
        ? await new Promise<ReadableStreamReadResult<Uint8Array>>(
          (resolve, reject) => {
            const onAbort = () =>
              reject(new DOMException("Aborted", "AbortError"));
            if (signal.aborted) {
              onAbort();
              return;
            }
            signal.addEventListener("abort", onAbort, { once: true });
            reader.read().then(
              (result) => {
                signal.removeEventListener("abort", onAbort);
                resolve(result);
              },
              (error) => {
                signal.removeEventListener("abort", onAbort);
                reject(error);
              },
            );
          },
        )
        : await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Authentication request failed (${response.status}).`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function fetchDiscovery(
  siteInput: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Discovery> {
  const site = normalizeSite(siteInput);
  const response = await fetchWithTimeout(
    fetchImpl,
    new URL("/.well-known/scoutpost-cli.json", site),
    {
      headers: { Accept: "application/json" },
      redirect: "manual",
    },
    timeoutMs,
  );
  if (
    response.type === "opaqueredirect" ||
    response.status >= 300 && response.status < 400
  ) {
    throw new Error("Scoutpost discovery redirects are not allowed.");
  }
  const data = await safeJson(response, new Set());
  if (
    data.version !== 1 ||
    (data.issuer !== site.origin && data.issuer !== "requested-site")
  ) {
    throw new Error("Scoutpost discovery is incompatible with this CLI.");
  }

  let apiOrigin: string;
  try {
    const advertised = new URL(
      typeof data.api_origin === "string" ? data.api_origin : site.origin,
      site,
    );
    requireSecure(advertised);
    if (advertised.username || advertised.password) throw new Error();
    apiOrigin = advertised.origin;
  } catch {
    throw new Error("Discovery contains an invalid api_origin.");
  }
  const allowedApiOrigins = new Set([site.origin, apiOrigin]);
  const discovery: Discovery = {
    version: 1,
    issuer: site.origin,
    api_origin: apiOrigin,
    api_base_url: endpoint(
      data.api_base_url,
      allowedApiOrigins,
      "api_base_url",
      site,
    ),
    device_authorization_endpoint: endpoint(
      data.device_authorization_endpoint,
      allowedApiOrigins,
      "device_authorization_endpoint",
      site,
    ),
    token_endpoint: endpoint(
      data.token_endpoint,
      allowedApiOrigins,
      "token_endpoint",
      site,
    ),
    verification_uri: endpoint(
      data.verification_uri,
      new Set([site.origin]),
      "verification_uri",
      site,
    ),
    api_key_management_url: endpoint(
      data.api_key_management_url,
      new Set([site.origin]),
      "api_key_management_url",
      site,
    ),
  };
  if (typeof data.public_gateway_key === "string" && data.public_gateway_key) {
    discovery.public_gateway_key = data.public_gateway_key;
  }
  return discovery;
}

function headers(discovery: Discovery, credential?: string): Headers {
  const result = new Headers({
    Accept: "application/json",
    "Content-Type": "application/json",
  });
  if (credential) result.set("Authorization", `Bearer ${credential}`);
  if (discovery.public_gateway_key) {
    result.set("apikey", discovery.public_gateway_key);
  }
  return result;
}

function apiUrl(discovery: Discovery, path: string): string {
  return `${discovery.api_base_url.replace(/\/$/, "")}/${
    path.replace(/^\//, "")
  }`;
}

async function verifyCredential(
  discovery: Discovery,
  credential: string,
  fetchImpl: typeof fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Account | null> {
  const response = await fetchWithTimeout(
    fetchImpl,
    apiUrl(discovery, "/user/me"),
    {
      headers: headers(discovery, credential),
      redirect: "manual",
    },
    timeoutMs,
  );
  if (response.status === 401) {
    await response.body?.cancel();
    return null;
  }
  const data = await safeJson(response, new Set());
  if (typeof data.user_id !== "string") {
    throw new Error("Credential verification returned an invalid response.");
  }
  return {
    user_id: data.user_id,
    email: typeof data.email === "string" ? data.email : null,
  };
}

function validDeviceResponse(
  data: Record<string, unknown>,
): DeviceAuthorization {
  if (
    typeof data.device_code !== "string" || data.device_code.length < 32 ||
    typeof data.user_code !== "string" ||
    !/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(data.user_code) ||
    typeof data.verification_uri !== "string" ||
    typeof data.verification_uri_complete !== "string" ||
    typeof data.expires_in !== "number" || data.expires_in < 60 ||
    data.expires_in > 1800 ||
    typeof data.interval !== "number" || data.interval < 1 || data.interval > 30
  ) {
    throw new Error(
      "Authentication server returned an invalid device request.",
    );
  }
  if (
    data.verification_uri_complete.includes(data.device_code) ||
    data.verification_uri_complete.includes(
      encodeURIComponent(data.device_code),
    )
  ) {
    throw new Error(
      "Authentication server returned an unsafe verification URL.",
    );
  }
  return data as unknown as DeviceAuthorization;
}

function validToken(data: Record<string, unknown>): TokenSuccess {
  if (
    data.token_type !== "api_key" || typeof data.api_key !== "string" ||
    !/^cj_[A-Za-z0-9_-]{20,}$/.test(data.api_key) ||
    typeof data.key_id !== "string" || typeof data.key_prefix !== "string" ||
    data.key_prefix !== data.api_key.slice(0, 11) ||
    !/^cj_[A-Za-z0-9_-]{8}$/.test(data.key_prefix) ||
    typeof data.name !== "string" || !data.account ||
    typeof data.account !== "object" ||
    typeof (data.account as Record<string, unknown>).user_id !== "string"
  ) {
    throw new Error("Authentication server returned an invalid credential.");
  }
  return data as unknown as TokenSuccess;
}

export async function login(
  options: {
    site: string;
    label: string;
    switchSite?: boolean;
    noBrowser?: boolean;
  },
  overrides: Partial<AuthDependencies> = {},
): Promise<void> {
  const deps = depsWith(overrides);
  const discovery = await fetchDiscovery(
    options.site,
    deps.fetch,
    deps.requestTimeoutMs,
  );
  const existing = deps.readConfig();
  const existingCredential = existing.api_key ?? existing.auth_token;
  if (existingCredential) {
    const existingApiMatches = existing.api_url?.replace(/\/$/, "") ===
      discovery.api_base_url.replace(/\/$/, "");
    const existingSite = existing.site_url ??
      (existingApiMatches ? discovery.issuer : undefined);
    if (
      (!existingSite || existingSite !== discovery.issuer ||
        !existingApiMatches) &&
      !options.switchSite
    ) {
      throw new Error(
        `An existing credential is configured for ${
          existingSite ?? existing.api_url ?? "an unknown target"
        }. Re-run with --switch to replace it.`,
      );
    }
    if (existingSite === discovery.issuer && existingApiMatches) {
      const account = await verifyCredential(
        discovery,
        existingCredential,
        deps.fetch,
        deps.requestTimeoutMs,
      );
      if (account) {
        deps.log(
          `Already authenticated to ${discovery.issuer} as ${
            account.email ?? account.user_id
          }.`,
        );
        return;
      }
    }
  }

  const createResponse = await fetchWithTimeout(
    deps.fetch,
    discovery.device_authorization_endpoint,
    {
      method: "POST",
      headers: headers(discovery),
      body: JSON.stringify({
        client_name: "Scout CLI",
        agent_label: options.label,
        site_origin: discovery.issuer,
      }),
      redirect: "manual",
    },
    deps.requestTimeoutMs,
  );
  const device = validDeviceResponse(
    await safeJson(createResponse, new Set(["rate_limit"])),
  );
  const completeUrl = new URL(device.verification_uri_complete);
  const expectedVerification = new URL(discovery.verification_uri);
  if (
    completeUrl.origin !== discovery.issuer ||
    completeUrl.pathname !== expectedVerification.pathname ||
    [...completeUrl.searchParams.keys()].some((key) => key !== "user_code") ||
    completeUrl.searchParams.get("user_code") !== device.user_code
  ) {
    throw new Error(
      "Authentication server returned an untrusted verification URL.",
    );
  }

  deps.log(`Open ${completeUrl.toString()}`);
  deps.log(`Confirm code: ${device.user_code}`);
  if (!options.noBrowser) {
    const opened = await deps.launchBrowser(completeUrl.toString());
    if (!opened) deps.warn("Could not open a browser; use the URL above.");
  }

  let intervalSeconds = device.interval;
  const deadline = deps.now() + device.expires_in * 1000;
  let token: TokenSuccess | null = null;
  let transientPollFailures = 0;
  while (deps.now() < deadline) {
    await deps.sleep(intervalSeconds * 1000);
    const remainingMs = deadline - deps.now();
    if (remainingMs <= 0) break;
    let response: Response;
    try {
      response = await fetchWithTimeout(
        deps.fetch,
        discovery.token_endpoint,
        {
          method: "POST",
          headers: headers(discovery),
          body: JSON.stringify({
            grant_type: DEVICE_GRANT_TYPE,
            device_code: device.device_code,
          }),
          redirect: "manual",
        },
        Math.min(deps.requestTimeoutMs, remainingMs),
      );
      transientPollFailures = 0;
    } catch (error) {
      transientPollFailures += 1;
      if (
        transientPollFailures < MAX_TRANSIENT_POLL_FAILURES &&
        deps.now() < deadline
      ) {
        deps.warn("Authentication service unavailable; retrying.");
        continue;
      }
      throw error;
    }
    const data = await readBoundedObject(response);
    if (response.ok) {
      try {
        token = validToken(data);
      } catch (error) {
        const rawKey = typeof data.api_key === "string" &&
            /^cj_[A-Za-z0-9_-]{20,}$/.test(data.api_key)
          ? data.api_key
          : null;
        if (rawKey) {
          const safePrefix = rawKey.slice(0, 11);
          const revoked = await bestEffortRevoke(
            discovery,
            rawKey,
            deps.fetch,
            deps.requestTimeoutMs,
          );
          if (!revoked) {
            throw new Error(
              `The authentication server returned an invalid credential that could not be revoked. Revoke ${safePrefix}… at ${discovery.api_key_management_url}, then run login again.`,
            );
          }
        }
        throw error;
      }
      break;
    }
    const code = typeof data.code === "string"
      ? data.code
      : typeof data.error === "string"
      ? data.error
      : "";
    if (code === "authorization_pending") continue;
    if (code === "slow_down" || response.status === 429) {
      const retryAfter = Number(response.headers.get("Retry-After"));
      intervalSeconds =
        Number.isFinite(retryAfter) && retryAfter > intervalSeconds
          ? Math.min(30, retryAfter)
          : Math.min(30, intervalSeconds + 5);
      continue;
    }
    if (code === "access_denied") throw new Error("Authentication was denied.");
    if (code === "expired_token") {
      throw new Error("Authentication request expired.");
    }
    if (code === "api_key_limit_reached") {
      throw new Error(
        `API key limit reached. Manage keys at ${discovery.api_key_management_url}.`,
      );
    }
    throw new Error(`Authentication request failed: HTTP ${response.status}.`);
  }
  if (!token) throw new Error("Authentication request expired.");

  let account: Account | null;
  try {
    account = await verifyCredential(
      discovery,
      token.api_key,
      deps.fetch,
      deps.requestTimeoutMs,
    );
  } catch {
    account = null;
  }
  if (!account) {
    const revoked = await bestEffortRevoke(
      discovery,
      token.api_key,
      deps.fetch,
      deps.requestTimeoutMs,
    );
    if (revoked) {
      throw new Error(
        "The new credential could not be verified and was revoked. Run login again.",
      );
    }
    throw new Error(
      `The new credential could not be verified or revoked. Revoke ${token.key_prefix}… at ${discovery.api_key_management_url}, then run login again.`,
    );
  }

  const next: Config = {
    ...existing,
    api_url: discovery.api_base_url,
    api_key: token.api_key,
    auth_token: undefined,
    supabase_anon_key: discovery.public_gateway_key,
    site_url: discovery.issuer,
    api_key_id: token.key_id,
    api_key_prefix: token.key_prefix,
    api_key_name: token.name,
    account_user_id: account.user_id,
    account_email: account.email ?? undefined,
  };
  try {
    deps.writeConfig(next);
  } catch (error) {
    const revoked = await bestEffortRevoke(
      discovery,
      token.api_key,
      deps.fetch,
      deps.requestTimeoutMs,
    );
    if (!revoked) {
      throw new Error(
        `The credential could not be stored or revoked. Revoke ${token.key_prefix}… at ${discovery.api_key_management_url}, then run login again.`,
      );
    }
    throw error;
  }
  deps.log(
    `Authenticated to ${discovery.issuer} as ${
      account.email ?? account.user_id
    }.`,
  );
  deps.log(
    `Credential ${token.key_prefix}… stored in ~/.scoutpost/config.json.`,
  );
}

async function bestEffortRevoke(
  discovery: Discovery,
  key: string,
  fetchImpl: typeof fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      apiUrl(discovery, "/api-keys/self"),
      {
        method: "DELETE",
        headers: headers(discovery, key),
        redirect: "manual",
      },
      timeoutMs,
    );
    const ok = response.ok;
    await response.body?.cancel();
    return ok;
  } catch {
    return false;
  }
}

export async function status(
  siteInput: string | undefined,
  overrides: Partial<AuthDependencies> = {},
): Promise<void> {
  const deps = depsWith(overrides);
  const cfg = deps.readConfig();
  const credential = cfg.api_key ?? cfg.auth_token;
  if (!credential) {
    deps.log("Not authenticated. Run `scout auth login`.");
    return;
  }
  if (
    siteInput && cfg.site_url &&
    normalizeSite(siteInput).origin !== normalizeSite(cfg.site_url).origin
  ) {
    throw new Error(
      `Refusing to send the active credential to a different site. Active site: ${cfg.site_url}.`,
    );
  }
  const site = siteInput ?? cfg.site_url;
  if (!site) throw new Error("No site metadata found; run `scout auth login`.");
  const discovery = await fetchDiscovery(
    site,
    deps.fetch,
    deps.requestTimeoutMs,
  );
  if (
    !cfg.site_url && cfg.api_url &&
    cfg.api_url.replace(/\/$/, "") !== discovery.api_base_url.replace(/\/$/, "")
  ) {
    throw new Error(
      `Refusing to send the active credential to a different API. Configured API: ${cfg.api_url}.`,
    );
  }
  const account = await verifyCredential(
    discovery,
    credential,
    deps.fetch,
    deps.requestTimeoutMs,
  );
  deps.log(`Site: ${discovery.issuer}`);
  deps.log(
    `Status: ${account ? "authenticated" : "credential invalid or revoked"}`,
  );
  if (account) deps.log(`Account: ${account.email ?? account.user_id}`);
  if (cfg.api_key_prefix) {
    deps.log(
      `Credential: ${cfg.api_key_prefix}… (${cfg.api_key_name ?? "Scout CLI"})`,
    );
  } else if (cfg.auth_token) deps.log("Credential: legacy session");
}

export async function logout(
  overrides: Partial<AuthDependencies> = {},
): Promise<void> {
  const deps = depsWith(overrides);
  const cfg = deps.readConfig();
  let remotelyRevoked = false;
  let managementUrl = cfg.site_url
    ? `${cfg.site_url}/?connect=api`
    : DEFAULT_SITE;
  if (cfg.api_key && cfg.site_url) {
    try {
      const discovery = await fetchDiscovery(
        cfg.site_url,
        deps.fetch,
        deps.requestTimeoutMs,
      );
      managementUrl = discovery.api_key_management_url;
      remotelyRevoked = await bestEffortRevoke(
        discovery,
        cfg.api_key,
        deps.fetch,
        deps.requestTimeoutMs,
      );
    } catch {
      remotelyRevoked = false;
    }
  }

  deps.writeConfig({
    ...cfg,
    api_key: undefined,
    auth_token: undefined,
    api_key_id: undefined,
    api_key_prefix: undefined,
    api_key_name: undefined,
    account_user_id: undefined,
    account_email: undefined,
  });

  if (cfg.api_key && !remotelyRevoked) {
    deps.warn(
      `Signed out locally, but remote revocation failed. Revoke the key at ${managementUrl}.`,
    );
  } else if (cfg.api_key) {
    deps.log("Signed out and revoked the CLI credential.");
  } else {
    deps.log("Signed out locally.");
  }
}

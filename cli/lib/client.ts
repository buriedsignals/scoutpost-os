// Shared REST client + helpers for scout

import { WindowsCredentialStore } from "./windows_credentials.ts";

export interface Config {
  api_url?: string;
  auth_token?: string;
  // api_key takes precedence over auth_token. Generated at /api in the app
  // (Agents → API → Create key). Format: cj_<base62>.
  api_key?: string;
  // Required by Supabase Edge Functions when sending a non-anon Bearer token.
  // Set alongside api_key when api_url points at hosted or raw Edge Functions.
  supabase_anon_key?: string;
  /** Public site used by browser-assisted login. */
  site_url?: string;
  /** Non-secret metadata for status/logout output. */
  api_key_id?: string;
  api_key_prefix?: string;
  api_key_name?: string;
  account_user_id?: string;
  account_email?: string;
}

export const KNOWN_HOSTED_SUPABASE_PROJECT_REF = "gfmdziplticfoak" + "hrfpt";

export interface CredentialStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
}

const CREDENTIAL_FIELDS = ["api_key", "auth_token"] as const;
const API_TIMEOUT_MS = 15_000;
// Civic discovery, preview, and creation perform bounded provider work inside
// Supabase Edge Functions. Keep this above the proxy's full connect/write/read
// budget so the CLI receives the real response (including a 504) instead of
// aborting a valid operation first.
export const CIVIC_API_TIMEOUT_MS = 190_000;
const MAX_API_RESPONSE_BYTES = 1024 * 1024;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function validateApiUrl(raw: string): string {
  if (!raw || /[\0\r\n]/.test(raw)) throw new Error("api_url is invalid");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      "api_url must be an absolute HTTPS URL (HTTP is allowed only for loopback)",
    );
  }
  const loopbackHttp = parsed.protocol === "http:" &&
    LOOPBACK_HOSTS.has(parsed.hostname);
  if (
    (parsed.protocol !== "https:" && !loopbackHttp) || parsed.username ||
    parsed.password ||
    parsed.search || parsed.hash
  ) {
    throw new Error(
      "api_url must use HTTPS without credentials, query, or fragment (HTTP is allowed only for loopback)",
    );
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.href.replace(/\/$/, "");
}

function platformCredentialStore(): CredentialStore | null {
  return Deno.build.os === "windows" ? new WindowsCredentialStore() : null;
}

export function configDir(
  os = Deno.build.os,
  env: Pick<typeof Deno.env, "get"> = Deno.env,
): string {
  if (os === "windows") {
    const appData = env.get("APPDATA");
    if (!appData) throw new Error("APPDATA environment variable is not set");
    return `${appData}\\Scoutpost`;
  }
  const home = env.get("HOME");
  if (!home) throw new Error("HOME environment variable is not set");
  return `${home}/.scoutpost`;
}

export function configPath(
  os = Deno.build.os,
  env: Pick<typeof Deno.env, "get"> = Deno.env,
): string {
  const dir = configDir(os, env);
  return os === "windows" ? `${dir}\\config.json` : `${dir}/config.json`;
}

function readPublicConfigFile(): Config {
  try {
    const raw = Deno.readTextFileSync(configPath());
    return JSON.parse(raw) as Config;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return {};
    throw err;
  }
}

function publicConfig(cfg: Config): Config {
  const sanitized = { ...cfg };
  delete sanitized.api_key;
  delete sanitized.auth_token;
  return sanitized;
}

function writePublicConfigFile(cfg: Config): void {
  const dir = configDir();
  const path = configPath();
  Deno.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    Deno.chmodSync(dir, 0o700);
  } catch {
    // Non-POSIX platforms may not support chmod; the mode option above is
    // still applied where the runtime supports it.
  }
  const temporaryPath = `${path}.tmp-${crypto.randomUUID()}`;
  Deno.writeTextFileSync(temporaryPath, JSON.stringify(cfg, null, 2) + "\n", {
    mode: 0o600,
  });
  try {
    Deno.chmodSync(temporaryPath, 0o600);
  } catch {
    // See directory chmod note.
  }
  try {
    Deno.renameSync(temporaryPath, path);
  } catch (error) {
    try {
      Deno.removeSync(temporaryPath);
    } catch {
      // Preserve the original write error. The temporary file was created
      // with mode 0600 even if cleanup is unavailable.
    }
    throw error;
  }
}

export function readConfigFile(
  credentialStore: CredentialStore | null = platformCredentialStore(),
): Config {
  const cfg = readPublicConfigFile();
  if (!credentialStore) return cfg;

  // One-time fail-closed migration for pre-Windows-support config files. The
  // plaintext file is replaced only after Credential Manager accepts both
  // values; a failed migration leaves the original intact.
  if (CREDENTIAL_FIELDS.some((field) => cfg[field] !== undefined)) {
    writeConfigFile(cfg, credentialStore);
    return cfg;
  }
  for (const field of CREDENTIAL_FIELDS) {
    const value = credentialStore.get(field);
    if (value !== undefined) cfg[field] = value;
  }
  return cfg;
}

export function writeConfigFile(
  cfg: Config,
  credentialStore: CredentialStore | null = platformCredentialStore(),
): void {
  if (!credentialStore) {
    writePublicConfigFile(cfg);
    return;
  }

  // Read the complete rollback state before the first mutation. If a
  // credential read fails, nothing is changed; a partially populated rollback
  // map must never be interpreted as permission to delete an unread value.
  const prior = new Map<string, string | undefined>();
  for (const field of CREDENTIAL_FIELDS) {
    prior.set(field, credentialStore.get(field));
  }
  try {
    for (const field of CREDENTIAL_FIELDS) {
      const value = cfg[field];
      if (value === undefined) credentialStore.delete(field);
      else credentialStore.set(field, value);
    }
    writePublicConfigFile(publicConfig(cfg));
  } catch (error) {
    for (const field of CREDENTIAL_FIELDS) {
      try {
        const value = prior.get(field);
        if (value === undefined) credentialStore.delete(field);
        else credentialStore.set(field, value);
      } catch {
        // Preserve the original failure. The caller receives a hard error and
        // must not assume the credential/config transaction committed.
      }
    }
    throw error;
  }
}

function isDirectory(path: string): boolean {
  try {
    return Deno.statSync(path).isDirectory;
  } catch {
    return false;
  }
}

export function isKnownHostedSupabaseTarget(
  apiUrl: string | undefined,
): boolean {
  return Boolean(apiUrl?.includes(KNOWN_HOSTED_SUPABASE_PROJECT_REF));
}

export function isSelfHostCheckout(cwd = Deno.cwd()): boolean {
  return isDirectory(`${cwd}/supabase/functions`) &&
    isDirectory(`${cwd}/frontend`);
}

export function hostedSupabaseTargetWarning(
  apiUrl: string | undefined,
  cwd = Deno.cwd(),
): string | null {
  if (!isKnownHostedSupabaseTarget(apiUrl) || !isSelfHostCheckout(cwd)) {
    return null;
  }
  return "This scout CLI is running from a self-host checkout but api_url points at " +
    `the hosted Scoutpost Supabase project (${KNOWN_HOSTED_SUPABASE_PROJECT_REF}). ` +
    "Set api_url to your newsroom Supabase project before creating or listing scouts.";
}

let warnedHostedSupabaseTarget = false;

export function warnIfKnownHostedSupabaseTarget(
  apiUrl: string | undefined,
  cwd = Deno.cwd(),
): void {
  const warning = hostedSupabaseTargetWarning(apiUrl, cwd);
  if (!warning || warnedHostedSupabaseTarget) return;
  warnedHostedSupabaseTarget = true;
  console.error(`[warning] ${warning}`);
}

// Resolved config — guaranteed to have an api_url and *some* credential
// (either api_key or auth_token). Optional fields stay optional so callers
// can detect which auth path is in use.
export interface ResolvedConfig {
  api_url: string;
  api_key?: string;
  auth_token?: string;
  supabase_anon_key?: string;
}

export function loadConfig(): ResolvedConfig {
  const cfg = readConfigFile();
  if (!cfg.api_url) {
    throw new Error(
      "api_url not set.\n" +
        "  Hosted Scoutpost: scout config set api_url=https://scoutpost.ai/functions/v1\n" +
        "  Self-hosted Supabase: scout config set api_url=https://<project>.supabase.co",
    );
  }
  cfg.api_url = validateApiUrl(cfg.api_url);
  if (!cfg.api_key && !cfg.auth_token) {
    throw new Error(
      "No credential set. Run browser authentication:\n" +
        "  scout auth login --site https://scoutpost.ai\n" +
        "For manual REST/CI recovery, generate a key under Connect Agent → API keys & REST, then:\n" +
        "  printf '%s\\n' \"$SCOUTPOST_API_KEY\" | scout config set api_key --stdin\n" +
        "  scout config set api_url=https://scoutpost.ai/functions/v1\n" +
        "  For hosted or raw Edge Functions, also set:\n" +
        "  printf '%s\\n' \"$SUPABASE_ANON_KEY\" | scout config set supabase_anon_key --stdin",
    );
  }
  // Warn (don't fail) if api_key is set against Edge Functions without anon key
  // — Kong/Supabase can reject before the function validates the cj_ key.
  if (
    cfg.api_key &&
    (cfg.api_url.includes("supabase.co") ||
      cfg.api_url.includes("/functions/v1")) &&
    !cfg.supabase_anon_key
  ) {
    console.error(
      "[warning] api_key set without supabase_anon_key. Edge Functions require " +
        "an `apikey:` header. Pipe the value to: scout config set supabase_anon_key --stdin",
    );
  }
  warnIfKnownHostedSupabaseTarget(cfg.api_url);
  return cfg as ResolvedConfig;
}

// Commands build paths as `/functions/v1/<function>` so the same command can
// talk to raw Supabase hosts and hosted proxy hosts. If the configured base URL
// already includes `/functions/v1`, strip the duplicate prefix before joining.
export function resolvePath(path: string, apiUrl: string): string {
  const prefixed = path.startsWith("/") ? path : `/${path}`;
  if (apiUrl.includes("/functions/v1")) {
    return prefixed.replace(/^\/functions\/v1(?=\/|$)/, "");
  }
  if (apiUrl.includes("supabase.co")) return prefixed;
  return prefixed.replace(/^\/functions\/v1\//, "/");
}

export async function apiFetch<T = unknown>(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = API_TIMEOUT_MS, ...requestInit } = init;
  const cfg = loadConfig();
  const url = `${cfg.api_url.replace(/\/$/, "")}${
    resolvePath(path, cfg.api_url)
  }`;
  const headers = new Headers(requestInit.headers);
  // api_key wins over auth_token. Edge Function front doors additionally need
  // an `apikey:` header populated with the project's anon key — without it the
  // auth layer can refuse the request before it ever hits the function code.
  const bearer = cfg.api_key ?? cfg.auth_token!;
  headers.set("Authorization", `Bearer ${bearer}`);
  if (cfg.supabase_anon_key) {
    headers.set("apikey", cfg.supabase_anon_key);
  }
  if (!headers.has("Content-Type") && requestInit.body) {
    headers.set("Content-Type", "application/json");
  }
  headers.set("Accept", "application/json");

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("Scoutpost API request timed out")),
    timeoutMs,
  );
  const upstreamSignal = requestInit.signal;
  const abortFromUpstream = () => controller.abort(upstreamSignal?.reason);
  if (upstreamSignal?.aborted) abortFromUpstream();
  else {upstreamSignal?.addEventListener("abort", abortFromUpstream, {
      once: true,
    });}
  let res: Response;
  let text: string;
  try {
    res = await fetch(url, {
      ...requestInit,
      headers,
      redirect: "error",
      signal: controller.signal,
    });
    text = await readBoundedResponse(res);
  } finally {
    clearTimeout(timeout);
    upstreamSignal?.removeEventListener("abort", abortFromUpstream);
  }
  let parsed: unknown = text;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // leave as string
    }
  }

  if (!res.ok) {
    const errPayload =
      parsed && typeof parsed === "object" && parsed !== null &&
        "error" in parsed
        ? (parsed as { error: unknown }).error
        : parsed;
    const errMsg = typeof errPayload === "string"
      ? errPayload
      : errPayload === undefined || errPayload === null
      ? "(empty body)"
      : JSON.stringify(errPayload);
    throw new Error(`API error ${res.status}: ${errMsg}`);
  }

  return parsed as T;
}

async function readBoundedResponse(response: Response): Promise<string> {
  if (!response.body) return "";
  const declared = Number(response.headers.get("Content-Length") ?? 0);
  if (declared > MAX_API_RESPONSE_BYTES) {
    await response.body.cancel();
    throw new Error("Scoutpost API response exceeds the 1 MiB limit");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > MAX_API_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Scoutpost API response exceeds the 1 MiB limit");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export function unwrapItems<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.items)) return obj.items as T[];
    if (Array.isArray(obj.data)) return obj.data as T[];
  }
  return [];
}

// ---- Arg parser (no deps) ------------------------------------------------

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const eq = key.indexOf("=");
      if (eq >= 0) {
        flags[key.slice(0, eq)] = key.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

// ---- Output helpers ------------------------------------------------------

export function isTerminal(): boolean {
  try {
    // Deno 2 exposes isTerminal on the stream
    const stdout = Deno.stdout as unknown as { isTerminal?: () => boolean };
    return typeof stdout.isTerminal === "function"
      ? stdout.isTerminal()
      : false;
  } catch {
    return false;
  }
}

export function color(code: string, s: string): string {
  if (!isTerminal()) return s;
  return `\x1b[${code}m${s}\x1b[0m`;
}

export function printTable(
  rows: Record<string, unknown>[],
  cols: string[],
): void {
  if (rows.length === 0) {
    console.log("(no rows)");
    return;
  }
  const cellStr = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  };

  const widths = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => cellStr(r[c]).length))
  );

  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  const header = cols
    .map((c, i) => c.padEnd(widths[i]))
    .join("  ");
  console.log(color("1", header));
  console.log(sep);
  for (const r of rows) {
    console.log(
      cols.map((c, i) => cellStr(r[c]).padEnd(widths[i])).join("  "),
    );
  }
}

export function printJSON(v: unknown): void {
  console.log(JSON.stringify(v, null, 2));
}

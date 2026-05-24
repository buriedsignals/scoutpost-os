// Shared REST client + helpers for scout

export interface Config {
  api_url?: string;
  auth_token?: string;
  // api_key takes precedence over auth_token. Generated at /api in the app
  // (Agents → API → Create key). Format: cj_<base62>.
  api_key?: string;
  // Required by Supabase Edge Functions when sending a non-anon Bearer token.
  // Set alongside api_key when api_url points at hosted or raw Edge Functions.
  supabase_anon_key?: string;
}

export const KNOWN_HOSTED_SUPABASE_PROJECT_REF = "gfmdziplticfoak" + "hrfpt";

export function configDir(): string {
  const home = Deno.env.get("HOME");
  if (!home) throw new Error("HOME environment variable is not set");
  return `${home}/.scoutpost`;
}

export function configPath(): string {
  return `${configDir()}/config.json`;
}

export function readConfigFile(): Config {
  try {
    const raw = Deno.readTextFileSync(configPath());
    return JSON.parse(raw) as Config;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return {};
    throw err;
  }
}

export function writeConfigFile(cfg: Config): void {
  Deno.mkdirSync(configDir(), { recursive: true });
  Deno.writeTextFileSync(configPath(), JSON.stringify(cfg, null, 2) + "\n");
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
  if (!cfg.api_key && !cfg.auth_token) {
    throw new Error(
      "No credential set. Generate an API key at https://scoutpost.ai → Agents → API → Create key, then:\n" +
        "  scout config set api_key=cj_xxx\n" +
        "  scout config set api_url=https://scoutpost.ai/functions/v1\n" +
        "  For hosted or raw Edge Functions, also set:\n" +
        "  scout config set supabase_anon_key=<SUPABASE_ANON_KEY>",
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
        "an `apikey:` header. Run: scout config set supabase_anon_key=<anon key>",
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
  init: RequestInit = {},
): Promise<T> {
  const cfg = loadConfig();
  const url = `${cfg.api_url.replace(/\/$/, "")}${
    resolvePath(path, cfg.api_url)
  }`;
  const headers = new Headers(init.headers);
  // api_key wins over auth_token. Edge Function front doors additionally need
  // an `apikey:` header populated with the project's anon key — without it the
  // auth layer can refuse the request before it ever hits the function code.
  const bearer = cfg.api_key ?? cfg.auth_token!;
  headers.set("Authorization", `Bearer ${bearer}`);
  if (cfg.supabase_anon_key) {
    headers.set("apikey", cfg.supabase_anon_key);
  }
  if (!headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json");
  }
  headers.set("Accept", "application/json");

  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
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

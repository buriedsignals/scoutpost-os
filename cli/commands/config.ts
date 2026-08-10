// scout config — manage public settings and platform-protected credentials
import {
  configPath,
  readConfigFile,
  validateApiUrl,
  warnIfKnownHostedSupabaseTarget,
  writeConfigFile,
} from "../lib/client.ts";

const VALID_KEYS = [
  "api_url",
  "auth_token",
  "api_key",
  "supabase_anon_key",
] as const;
type Key = typeof VALID_KEYS[number];

function usage(): void {
  console.log(
    [
      "Usage: scout config <subcommand>",
      "",
      "  get <key>            Print a config value (credentials are redacted)",
      "  set <key>=<value>    Write a public value to config",
      "  set <secret> --stdin Read a credential from protected stdin",
      "  unset <key>          Remove a public value or protected credential",
      "  show                 Show the full config (secrets redacted)",
      "",
      "Keys:",
      "  api_url              Base URL for the scout API (hosted broker or direct Supabase EF)",
      "  auth_token           Bearer JWT (legacy SaaS / cookieless session)",
      "  api_key              cj_… API key — preferred over auth_token when set",
      "  supabase_anon_key    Supabase anon key — sent as `apikey:` header when",
      "                       talking to hosted or direct Edge Functions",
      "",
      `Public config file: ${configPath()}`,
      Deno.build.os === "windows"
        ? "Credentials: Windows Credential Manager (current user)"
        : "Credentials: private config file (owner-only permissions)",
    ].join("\n"),
  );
}

function redact(token: string): string {
  if (!token) return "";
  if (token.length <= 8) return "****";
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

const SECRET_KEYS: ReadonlySet<Key> = new Set([
  "auth_token",
  "api_key",
  "supabase_anon_key",
]);

const MAX_STDIN_SECRET_BYTES = 16_384;

async function readSecretFromStdin(): Promise<string> {
  const reader = Deno.stdin.readable.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_STDIN_SECRET_BYTES) {
        throw new Error("Credential exceeds the stdin size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const raw = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  if (value.endsWith("\n")) value = value.slice(0, -1);
  if (value.endsWith("\r")) value = value.slice(0, -1);
  if (!value || /[\0\r\n]/.test(value)) {
    throw new Error("Credential stdin must contain exactly one non-empty line");
  }
  return value;
}

export async function parseConfigSet(
  rest: string[],
  readSecret: () => Promise<string> = readSecretFromStdin,
): Promise<{ key: Key; value: string }> {
  if (rest.length === 2 && rest[1] === "--stdin") {
    const key = rest[0] as Key;
    if (!VALID_KEYS.includes(key) || !SECRET_KEYS.has(key)) {
      throw new Error("--stdin is accepted only for a credential key");
    }
    return { key, value: await readSecret() };
  }
  const pair = rest.join(" ");
  const eq = pair.indexOf("=");
  if (eq < 0) {
    throw new Error(
      "Usage: scout config set <key>=<value> or set <secret> --stdin",
    );
  }
  const key = pair.slice(0, eq).trim() as Key;
  const value = pair.slice(eq + 1).trim();
  if (!VALID_KEYS.includes(key)) {
    throw new Error(
      `Unknown key: ${key}. Valid keys: ${VALID_KEYS.join(", ")}`,
    );
  }
  if (SECRET_KEYS.has(key)) {
    throw new Error(
      `Refusing ${key} in command arguments; pipe it to: scout config set ${key} --stdin`,
    );
  }
  if (!value || /[\0\r\n]/.test(value)) {
    throw new Error("Value must be one non-empty line");
  }
  return { key, value: key === "api_url" ? validateApiUrl(value) : value };
}

export async function run(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;

  if (!sub || sub === "--help" || sub === "-h") {
    usage();
    if (!sub) Deno.exit(1);
    return;
  }

  if (sub === "show") {
    const cfg = readConfigFile();
    warnIfKnownHostedSupabaseTarget(cfg.api_url);
    const display: Record<string, string> = {};
    for (const k of VALID_KEYS) {
      const v = cfg[k];
      if (v === undefined) {
        display[k] = "(unset)";
      } else if (SECRET_KEYS.has(k)) {
        display[k] = redact(v);
      } else {
        display[k] = v;
      }
    }
    console.log(JSON.stringify(display, null, 2));
    return;
  }

  if (sub === "get") {
    const key = rest[0];
    if (!key || !VALID_KEYS.includes(key as Key)) {
      console.error(`Usage: scout config get <${VALID_KEYS.join("|")}>`);
      Deno.exit(1);
    }
    const cfg = readConfigFile();
    const val = cfg[key as Key];
    if (val === undefined) {
      console.error(`${key} is not set`);
      Deno.exit(1);
    }
    console.log(SECRET_KEYS.has(key as Key) ? redact(val) : val);
    return;
  }

  if (sub === "set") {
    const { key, value } = await parseConfigSet(rest);
    const cfg = readConfigFile();
    cfg[key] = value;
    writeConfigFile(cfg);
    console.log(`Set ${key}`);
    return;
  }

  if (sub === "unset") {
    const key = rest[0] as Key;
    if (rest.length !== 1 || !VALID_KEYS.includes(key)) {
      throw new Error(`Usage: scout config unset <${VALID_KEYS.join("|")}>`);
    }
    const cfg = readConfigFile();
    delete cfg[key];
    writeConfigFile(cfg);
    console.log(`Unset ${key}`);
    return;
  }

  console.error(`Unknown subcommand: ${sub}`);
  usage();
  Deno.exit(1);
}

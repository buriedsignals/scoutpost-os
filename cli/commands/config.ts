// scout config — manage ~/.scoutpost/config.json
import {
  configPath,
  readConfigFile,
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
      "  set <key>=<value>    Write key/value to config",
      "  show                 Show the full config (secrets redacted)",
      "",
      "Keys:",
      "  api_url              Base URL for the scout API (hosted broker or direct Supabase EF)",
      "  auth_token           Bearer JWT (legacy SaaS / cookieless session)",
      "  api_key              cj_… API key — preferred over auth_token when set",
      "  supabase_anon_key    Supabase anon key — sent as `apikey:` header when",
      "                       talking to hosted or direct Edge Functions",
      "",
      `Config file: ${configPath()}`,
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

export function run(argv: string[]): void {
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
    const pair = rest.join(" ");
    const eq = pair.indexOf("=");
    if (eq < 0) {
      console.error("Usage: scout config set <key>=<value>");
      Deno.exit(1);
    }
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!VALID_KEYS.includes(key as Key)) {
      console.error(
        `Unknown key: ${key}. Valid keys: ${VALID_KEYS.join(", ")}`,
      );
      Deno.exit(1);
    }
    if (!value) {
      console.error("Value cannot be empty");
      Deno.exit(1);
    }
    const cfg = readConfigFile();
    cfg[key as Key] = value;
    writeConfigFile(cfg);
    console.log(`Set ${key}`);
    return;
  }

  console.error(`Unknown subcommand: ${sub}`);
  usage();
  Deno.exit(1);
}

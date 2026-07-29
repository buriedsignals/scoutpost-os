import { DEFAULT_SITE, login, logout, status } from "../lib/auth.ts";
import { parseArgs } from "../lib/client.ts";

function usage(): void {
  console.log(
    [
      "Usage: scout auth <subcommand>",
      "",
      "  login [--site URL] [--label NAME] [--switch] [--no-browser]",
      "  status [--site URL]",
      "  logout",
      "",
      "Browser login creates and stores a scoped Scoutpost API key without",
      "putting the key in terminal arguments, output, or browser URLs.",
    ].join("\n"),
  );
}

function flagString(
  flags: Record<string, string | boolean>,
  name: string,
): string | undefined {
  const value = flags[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`--${name} requires a value`);
  return value;
}

export function authUsageExitCode(
  sub: string | undefined,
  flags: Record<string, string | boolean>,
): number | null {
  if (sub === "help" || flags.help !== undefined || flags.h !== undefined) {
    return 0;
  }
  return sub ? null : 1;
}

export async function run(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const [sub] = positional;
  const usageExitCode = authUsageExitCode(sub, flags);
  if (usageExitCode !== null) {
    usage();
    if (usageExitCode !== 0) Deno.exit(usageExitCode);
    return;
  }
  if (sub === "login") {
    await login({
      site: flagString(flags, "site") ?? DEFAULT_SITE,
      label: flagString(flags, "label") ?? "Scout CLI",
      switchSite: flags.switch === true,
      noBrowser: flags["no-browser"] === true,
    });
    return;
  }
  if (sub === "status") {
    await status(flagString(flags, "site"));
    return;
  }
  if (sub === "logout") {
    await logout();
    return;
  }
  throw new Error(`Unknown auth subcommand: ${sub}`);
}

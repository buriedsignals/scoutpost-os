#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-write --allow-ffi --allow-run=/usr/bin/open,/usr/bin/xdg-open
// scout — Scoutpost CLI
// Entry point: dispatches subcommands to commands/<name>.ts

import * as auth from "./commands/auth.ts";
import * as config from "./commands/config.ts";
import * as civic from "./commands/civic.ts";
import * as ingest from "./commands/ingest.ts";
import * as projects from "./commands/projects.ts";
import * as promises from "./commands/promises.ts";
import * as scouts from "./commands/scouts.ts";
import * as snapshots from "./commands/snapshots.ts";
import * as units from "./commands/units.ts";
import * as user from "./commands/user.ts";
import { VERSION } from "./lib/version.ts";

const SUBCOMMANDS = [
  "config",
  "civic",
  "auth",
  "projects",
  "promises",
  "scouts",
  "units",
  "snapshots",
  "user",
  "ingest",
] as const;

type Subcommand = typeof SUBCOMMANDS[number];

const COMMANDS: Record<
  Subcommand,
  { run: (argv: string[]) => void | Promise<void> }
> = {
  config,
  civic,
  auth,
  projects,
  promises,
  scouts,
  units,
  snapshots,
  user,
  ingest,
};

function printUsage(): void {
  const lines = [
    "scout — Scoutpost CLI",
    "",
    "Usage: scout <command> [args...]",
    "",
    "Commands:",
    "  auth       Sign in, check status, or revoke the local CLI credential",
    "  config     Manage public settings and OS-protected credentials",
    "  civic      Discover, preview, and inspect Civic accountability leads",
    "  projects   List, add, show, delete projects",
    "  promises   Read Civic promises and apply human lifecycle status",
    "  scouts     List, add, show, update, run, pause, resume, delete scouts",
    "  units      List, show, verify, reject, mark-used, search information units",
    "  snapshots  List and download archived Page Scout evidence snapshots",
    "  user       Show current user account state",
    "  ingest     Ingest a URL or raw text into the knowledge base",
    "",
    "Run `scout <command> --help` for command-specific usage.",
  ];
  console.log(lines.join("\n"));
}

async function main(): Promise<void> {
  const [cmd, ...rest] = Deno.args;

  if (cmd === "--version" || cmd === "-v") {
    console.log(`scout ${VERSION}`);
    Deno.exit(0);
  }

  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    printUsage();
    Deno.exit(cmd ? 0 : 1);
  }

  if (!SUBCOMMANDS.includes(cmd as Subcommand)) {
    console.error(`Unknown command: ${cmd}`);
    console.error("");
    printUsage();
    Deno.exit(1);
  }

  try {
    await COMMANDS[cmd as Subcommand].run(rest);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    Deno.exit(1);
  }
}

if (import.meta.main) {
  await main();
}

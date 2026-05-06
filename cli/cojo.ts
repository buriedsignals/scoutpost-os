#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-write
// cojo — coJournalist v2 CLI
// Entry point: dispatches subcommands to commands/<name>.ts

import * as config from "./commands/config.ts";
import * as ingest from "./commands/ingest.ts";
import * as projects from "./commands/projects.ts";
import * as scouts from "./commands/scouts.ts";
import * as units from "./commands/units.ts";
import * as user from "./commands/user.ts";
import { VERSION } from "./lib/version.ts";

const SUBCOMMANDS = [
  "config",
  "projects",
  "scouts",
  "units",
  "user",
  "ingest",
] as const;

type Subcommand = typeof SUBCOMMANDS[number];

const COMMANDS: Record<
  Subcommand,
  { run: (argv: string[]) => void | Promise<void> }
> = {
  config,
  projects,
  scouts,
  units,
  user,
  ingest,
};

function printUsage(): void {
  const lines = [
    "cojo — coJournalist v2 CLI",
    "",
    "Usage: cojo <command> [args...]",
    "",
    "Commands:",
    "  config     Manage ~/.cojournalist/config.json (api_url, api_key, auth_token)",
    "  projects   List, add, show, delete projects",
    "  scouts     List, add, show, update, run, pause, resume, delete scouts",
    "  units      List, show, verify, reject, mark-used, search information units",
    "  user       Show current user account state",
    "  ingest     Ingest a URL or raw text into the knowledge base",
    "",
    "Run `cojo <command> --help` for command-specific usage.",
  ];
  console.log(lines.join("\n"));
}

async function main(): Promise<void> {
  const [cmd, ...rest] = Deno.args;

  if (cmd === "--version" || cmd === "-v") {
    console.log(`cojo ${VERSION}`);
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

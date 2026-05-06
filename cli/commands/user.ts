// cojo user — current account state
import { apiFetch, printJSON } from "../lib/client.ts";

function usage(): void {
  console.log(
    [
      "Usage: cojo user <subcommand>",
      "",
      "  me     Show the authenticated user's tier, credits, and team state",
    ].join("\n"),
  );
}

export async function run(argv: string[]): Promise<void> {
  const [sub] = argv;

  if (!sub || sub === "--help" || sub === "-h") {
    usage();
    if (!sub) Deno.exit(1);
    return;
  }

  switch (sub) {
    case "me": {
      const user = await apiFetch("/functions/v1/user/me");
      printJSON(user);
      return;
    }
    default:
      console.error(`Unknown subcommand: ${sub}`);
      usage();
      Deno.exit(1);
  }
}

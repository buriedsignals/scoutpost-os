/**
 * Fetch a MuckRock user or organization and print only entitlement/team fields.
 *
 * Usage:
 *   MUCKROCK_CLIENT_ID=... MUCKROCK_CLIENT_SECRET=... \
 *     deno run --allow-env --allow-net scripts/check-muckrock-entitlements.ts --user <uuid>
 *
 *   MUCKROCK_CLIENT_ID=... MUCKROCK_CLIENT_SECRET=... \
 *     deno run --allow-env --allow-net scripts/check-muckrock-entitlements.ts --org <uuid>
 *
 * This intentionally does not print access tokens, client secrets, billing
 * cards, admin emails, or full user/org payloads.
 */

import {
  isCojournalistTeamEntitlement,
  resolveTier,
} from "../supabase/functions/_shared/entitlements.ts";
import {
  MuckrockClient,
  type MuckrockEntitlement,
  type MuckrockOrg,
} from "../supabase/functions/_shared/muckrock.ts";

interface Args {
  userUuid?: string;
  orgUuid?: string;
}

function usage(): never {
  console.error(
    "Usage: deno run --allow-env --allow-net scripts/check-muckrock-entitlements.ts (--user <uuid> | --org <uuid>)",
  );
  Deno.exit(1);
}

function parseArgs(args: string[]): Args {
  const parsed: Args = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--user") {
      parsed.userUuid = args[++i];
    } else if (arg === "--org") {
      parsed.orgUuid = args[++i];
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  if (Boolean(parsed.userUuid) === Boolean(parsed.orgUuid)) usage();
  return parsed;
}

function summarizeEntitlement(ent: MuckrockEntitlement) {
  return {
    name: ent.name,
    slug: ent.slug ?? null,
    resources: ent.resources ?? {},
    update_on: ent.update_on ?? null,
    cojournalist_team_match: isCojournalistTeamEntitlement(ent),
  };
}

function summarizeOrg(org: MuckrockOrg) {
  return {
    uuid: org.uuid,
    name: org.name ?? null,
    individual: org.individual ?? null,
    max_users: org.max_users ?? null,
    entitlements: (org.entitlements ?? []).map(summarizeEntitlement),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(Deno.args);
  const client = new MuckrockClient();

  if (args.userUuid) {
    const user = await client.fetchUserData(args.userUuid);
    console.log(JSON.stringify(
      {
        kind: "user",
        uuid: user.uuid,
        preferred_username: user.preferred_username ?? null,
        resolved: resolveTier(user.organizations),
        organizations: (user.organizations ?? []).map(summarizeOrg),
      },
      null,
      2,
    ));
    return;
  }

  if (args.orgUuid) {
    const org = await client.fetchOrgData(args.orgUuid);
    const entitlements = org.entitlements ?? [];
    console.log(JSON.stringify(
      {
        kind: "organization",
        organization: summarizeOrg(org),
        has_cojournalist_team_entitlement: entitlements.some(
          isCojournalistTeamEntitlement,
        ),
      },
      null,
      2,
    ));
  }
}

await main();

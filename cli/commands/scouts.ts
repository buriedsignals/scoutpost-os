// scout scouts — manage scouts
import {
  apiFetch,
  parseArgs,
  printJSON,
  printTable,
  unwrapItems,
} from "../lib/client.ts";

function usage(): void {
  console.log(
    [
      "Usage: scout scouts <subcommand>",
      "",
      "  list",
      "  add --name <name> --type <web|beat|social|civic|transport> [--url <url>]",
      "                   [--topic <tag,tag>] [--description <text>]",
      "                   [--criteria <text>] [--project <id>]",
      "                   [--cron <expr>] [--regularity daily|weekly|monthly|3h|6h|12h]",
      "                   [--time HH:MM] [--day N]",
      "                   [--location-json <json>] [--source-mode reliable|niche]",
      "                   [--priority-sources <domain,domain>]",
      "                   [--root-domain <domain>] [--tracked-urls <url,url>]",
      "                   [--platform instagram|x|facebook|tiktok] [--handle <handle>]",
      "                   [--monitor-mode summarize|criteria] [--track-removals true|false]",
      "                   [--mode aircraft|vessel|satellite]",
      "                   [--geofence-preset <id> | --center-lat <n> --center-lon <n> --radius-km <n>]",
      "                   [--watch-ids <id,id>] [--categories <cat,cat>]",
      "",
      "  Topic tags are short comma-separated labels, not long criteria. Use 1-3.",
      "  Beat and civic scouts support weekly or monthly schedules only.",
      "  Transport scouts (aircraft/vessel/satellite) support 3h/6h/12h/daily",
      "  (satellite daily only). Vessel needs a geofence; satellite needs a",
      "  geofence and --watch-ids; aircraft needs a geofence or --watch-ids.",
      "  Give a geofence as --geofence-preset OR all of",
      "  --center-lat/--center-lon/--radius-km (not both). --time defaults to",
      "  09:00 when omitted.",
      "",
      "  update <id> [--name <name>] [--topic <tag,tag>] [--description <text>]",
      "              [--criteria <text>] [--url <url>] [--cron <expr>]",
      "              [--active true|false] [--regularity daily|weekly|monthly]",
      "              [--time HH:MM] [--day N] [--location-json <json>]",
      "              [--source-mode reliable|niche]",
      "              [--priority-sources <domain,domain>]",
      "              [--root-domain <domain>] [--tracked-urls <url,url>]",
      "  show <id>",
      "  run <id>",
      "  pause <id>",
      "  resume <id>",
      "  delete <id>",
    ].join("\n"),
  );
}

interface Scout {
  id: string;
  name: string;
  type: string;
  is_active: boolean;
  consecutive_failures?: number;
}

const VALID_TYPES = ["web", "beat", "social", "civic", "transport"];
const TRANSPORT_MODES = ["aircraft", "vessel", "satellite"];
const TRANSPORT_REGULARITIES = ["3h", "6h", "12h", "daily"];

function stringFlag(
  flags: Record<string, string | boolean>,
  key: string,
): string | undefined {
  const value = flags[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseNumericFlag(
  flags: Record<string, string | boolean>,
  key: string,
  parse: (value: string) => number,
): number | undefined {
  const value = stringFlag(flags, key);
  if (!value) return undefined;
  const parsed = parse(value);
  if (!Number.isFinite(parsed)) {
    console.error(`--${key} must be a number`);
    Deno.exit(1);
  }
  return parsed;
}

/** Integer flag (e.g. --day). */
function numberFlag(
  flags: Record<string, string | boolean>,
  key: string,
): number | undefined {
  return parseNumericFlag(flags, key, (v) => Number.parseInt(v, 10));
}

/** Decimal flag — geofence lat/lon/radius are decimals, and parseInt would
 * silently truncate 26.5 -> 26 (~55km off). */
function floatFlag(
  flags: Record<string, string | boolean>,
  key: string,
): number | undefined {
  return parseNumericFlag(flags, key, Number.parseFloat);
}

function boolFlag(
  flags: Record<string, string | boolean>,
  key: string,
): boolean | undefined {
  const value = flags[key];
  if (value === undefined) return undefined;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  console.error(`--${key} must be true or false`);
  Deno.exit(1);
}

function listFlag(
  flags: Record<string, string | boolean>,
  key: string,
): string[] | undefined {
  const value = stringFlag(flags, key);
  if (!value) return undefined;
  const items = value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

function topicFlag(
  flags: Record<string, string | boolean>,
): string | undefined {
  const tags = listFlag(flags, "topic");
  if (!tags) return undefined;
  if (tags.length > 3) {
    console.error("--topic accepts at most 3 comma-separated tags");
    Deno.exit(1);
  }
  for (const tag of tags) {
    if (tag.length > 50) {
      console.error(
        "--topic tags must be 50 characters or less; use --description or --criteria for longer context",
      );
      Deno.exit(1);
    }
  }
  return tags.join(", ");
}

function cronIsNoMoreFrequentThanWeekly(cron: string): boolean {
  const trimmed = cron.trim();
  if (!trimmed) return true;
  const macro = trimmed.toLowerCase();
  if (["@weekly", "@monthly", "@yearly", "@annually"].includes(macro)) {
    return true;
  }
  if (["@daily", "@hourly", "@reboot"].includes(macro)) return false;

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) return true;
  const [, , dayOfMonth, , dayOfWeek] = parts;
  const single = (field: string) =>
    field !== "*" && field !== "?" && !/[,\-/]/.test(field);
  if (single(dayOfMonth) && dayOfWeek === "*") return true;
  if (dayOfMonth === "*" && single(dayOfWeek)) return true;
  return false;
}

function validateSchedulePolicy(
  type: string,
  regularity?: string,
  cron?: string,
  transportMode?: string,
): void {
  // Sub-daily regularities are transport-only.
  if (
    type !== "transport" && regularity &&
    ["3h", "6h", "12h"].includes(regularity)
  ) {
    console.error(`${type} scouts do not support sub-daily schedules`);
    Deno.exit(1);
  }
  if (type === "transport") {
    if (transportMode === "satellite") {
      if (regularity && regularity !== "daily") {
        console.error("satellite transport scouts support daily schedules only");
        Deno.exit(1);
      }
    } else if (regularity && !TRANSPORT_REGULARITIES.includes(regularity)) {
      console.error("transport scouts support 3h, 6h, 12h, or daily schedules");
      Deno.exit(1);
    }
    return;
  }
  if (type !== "beat" && type !== "civic") return;
  if (
    regularity === "daily" || (cron && !cronIsNoMoreFrequentThanWeekly(cron))
  ) {
    console.error(`${type} scouts support weekly or monthly schedules only`);
    Deno.exit(1);
  }
}

/** Assemble the transport config JSONB from CLI flags. */
function buildTransportConfig(
  flags: Record<string, string | boolean>,
): Record<string, unknown> {
  const config: Record<string, unknown> = { mode: stringFlag(flags, "mode") };
  const preset = stringFlag(flags, "geofence-preset");
  const lat = floatFlag(flags, "center-lat");
  const lon = floatFlag(flags, "center-lon");
  const radius = floatFlag(flags, "radius-km");
  const anyCircleFlag = lat !== undefined || lon !== undefined ||
    radius !== undefined;
  const allCircleFlags = lat !== undefined && lon !== undefined &&
    radius !== undefined;
  // A preset and a custom circle are mutually exclusive; silently keeping the
  // preset would discard the user's coordinates (backend's "not both" guard
  // never gets to fire because the circle never leaves the CLI).
  if (preset && anyCircleFlag) {
    console.error(
      "provide either --geofence-preset or --center-lat/--center-lon/--radius-km, not both",
    );
    Deno.exit(1);
  }
  // A partial circle (e.g. --center-lat/--center-lon but no --radius-km) must
  // be a hard error, not a silently dropped geofence — otherwise the scope the
  // user asked for vanishes and, for aircraft with --watch-ids, the scout runs
  // globally instead of over the intended area.
  if (!preset && anyCircleFlag && !allCircleFlags) {
    console.error(
      "a circular geofence needs all of --center-lat, --center-lon, and --radius-km",
    );
    Deno.exit(1);
  }
  if (preset) {
    config.geofence = { preset_id: preset };
  } else if (allCircleFlags) {
    config.geofence = { center: { lat, lon }, radius_km: radius };
  }
  const watchIds = listFlag(flags, "watch-ids");
  if (watchIds?.length) config.watch_ids = watchIds;
  const categories = listFlag(flags, "categories");
  if (categories?.length) config.categories = categories;
  const criteria = stringFlag(flags, "criteria");
  if (criteria) config.criteria = criteria;
  return config;
}

function jsonObjectFlag(
  flags: Record<string, string | boolean>,
  key: string,
): Record<string, unknown> | undefined {
  const value = stringFlag(flags, key);
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to error
  }
  console.error(`--${key} must be a JSON object`);
  Deno.exit(1);
}

export async function run(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;

  if (!sub || sub === "--help" || sub === "-h") {
    usage();
    if (!sub) Deno.exit(1);
    return;
  }

  const { positional, flags } = parseArgs(rest);

  switch (sub) {
    case "list": {
      const data = await apiFetch<Scout[] | { data: Scout[] }>(
        "/functions/v1/scouts",
      );
      const rows = unwrapItems<Scout>(data);
      printTable(
        rows as unknown as Record<string, unknown>[],
        ["id", "name", "type", "is_active", "consecutive_failures"],
      );
      return;
    }
    case "add": {
      if (typeof flags.name !== "string") {
        console.error("--name is required");
        Deno.exit(1);
      }
      if (
        typeof flags.type !== "string" || !VALID_TYPES.includes(flags.type)
      ) {
        console.error(`--type must be one of: ${VALID_TYPES.join(", ")}`);
        Deno.exit(1);
      }
      const body: Record<string, unknown> = {
        name: flags.name,
        type: flags.type,
      };
      const url = stringFlag(flags, "url");
      const criteria = stringFlag(flags, "criteria");
      const topic = topicFlag(flags);
      const description = stringFlag(flags, "description");
      const project = stringFlag(flags, "project");
      const cron = stringFlag(flags, "cron");
      const regularity = stringFlag(flags, "regularity");
      const time = stringFlag(flags, "time");
      const sourceMode = stringFlag(flags, "source-mode");
      const rootDomain = stringFlag(flags, "root-domain");
      const platform = stringFlag(flags, "platform");
      const handle = stringFlag(flags, "handle");
      const monitorMode = stringFlag(flags, "monitor-mode");
      const location = jsonObjectFlag(flags, "location-json");
      const prioritySources = listFlag(flags, "priority-sources");
      const trackedUrls = listFlag(flags, "tracked-urls");
      const day = numberFlag(flags, "day");
      const trackRemovals = boolFlag(flags, "track-removals");
      const transportMode = stringFlag(flags, "mode");
      validateSchedulePolicy(flags.type, regularity, cron, transportMode);

      if (url) body.url = url;
      if (criteria) body.criteria = criteria;
      if (topic) body.topic = topic;
      if (description) body.description = description;
      if (project) body.project_id = project;
      if (cron) body.schedule_cron = cron;
      if (regularity) body.regularity = regularity;
      if (time) body.time = time;
      if (day !== undefined) body.day_number = day;
      if (location) body.location = location;
      if (sourceMode) body.source_mode = sourceMode;
      if (prioritySources) body.priority_sources = prioritySources;
      if (rootDomain) body.root_domain = rootDomain;
      if (trackedUrls) body.tracked_urls = trackedUrls;
      if (platform) body.platform = platform;
      if (handle) body.profile_handle = handle;
      if (monitorMode) body.monitor_mode = monitorMode;
      if (trackRemovals !== undefined) body.track_removals = trackRemovals;

      if (flags.type === "transport") {
        if (!transportMode || !TRANSPORT_MODES.includes(transportMode)) {
          console.error(
            `transport scouts require --mode ${TRANSPORT_MODES.join("|")}`,
          );
          Deno.exit(1);
        }
        const config = buildTransportConfig(flags);
        const hasGeofence = Boolean(config.geofence);
        const hasWatchIds = Boolean(config.watch_ids);
        if (transportMode === "vessel" && !hasGeofence) {
          console.error("vessel transport scouts require a geofence");
          Deno.exit(1);
        }
        if (transportMode === "satellite" && (!hasGeofence || !hasWatchIds)) {
          console.error(
            "satellite transport scouts require a geofence and --watch-ids",
          );
          Deno.exit(1);
        }
        if (transportMode === "aircraft" && !hasGeofence && !hasWatchIds) {
          console.error(
            "aircraft transport scouts require a geofence or --watch-ids",
          );
          Deno.exit(1);
        }
        body.config = config;
        // criteria lives inside config for transport; drop the top-level copy.
        delete body.criteria;
        // A transport schedule needs a time anchor: the backend synthesizes the
        // cron from (regularity, time), so without a time it stores schedule_cron
        // = null and the scout is created INACTIVE and never runs. The UI always
        // sends 09:00 by default; match that here so a CLI create actually runs.
        if (!body.time && !cron) body.time = "09:00";
      }
      if (flags.type === "civic" && (!rootDomain || !trackedUrls?.length)) {
        console.error(
          "civic scouts require --root-domain and --tracked-urls",
        );
        Deno.exit(1);
      }
      if (flags.type === "social" && (!platform || !handle)) {
        console.error("social scouts require --platform and --handle");
        Deno.exit(1);
      }
      if (flags.type !== "transport" && !topic && !location) {
        console.error(
          "scouts require --topic with 1-3 short tags or --location-json",
        );
        Deno.exit(1);
      }

      const created = await apiFetch<Scout>("/functions/v1/scouts", {
        method: "POST",
        body: JSON.stringify(body),
      });
      printJSON(created);
      return;
    }
    case "show": {
      const id = positional[0];
      if (!id) {
        console.error("Usage: scout scouts show <id>");
        Deno.exit(1);
      }
      const scout = await apiFetch<Scout>(`/functions/v1/scouts/${id}`);
      printJSON(scout);
      return;
    }
    case "update": {
      const id = positional[0];
      if (!id) {
        console.error(
          "Usage: scout scouts update <id> [--name ...] [--topic ...] [--description ...] [--criteria ...] [--url ...] [--cron ...] [--active true|false]",
        );
        Deno.exit(1);
      }
      const patch: Record<string, unknown> = {};
      if (typeof flags.name === "string") patch.name = flags.name;
      if (typeof flags.criteria === "string") patch.criteria = flags.criteria;
      const topic = topicFlag(flags);
      if (topic) patch.topic = topic;
      if (typeof flags.description === "string") {
        patch.description = flags.description;
      }
      if (typeof flags.url === "string") patch.url = flags.url;
      if (typeof flags.cron === "string") patch.schedule_cron = flags.cron;
      if (typeof flags.regularity === "string") {
        patch.regularity = flags.regularity;
      }
      if (typeof flags.time === "string") patch.time = flags.time;
      const day = numberFlag(flags, "day");
      if (day !== undefined) patch.day_number = day;
      if (typeof flags["source-mode"] === "string") {
        patch.source_mode = flags["source-mode"];
      }
      if (typeof flags["root-domain"] === "string") {
        patch.root_domain = flags["root-domain"];
      }
      const trackedUrls = listFlag(flags, "tracked-urls");
      if (trackedUrls) patch.tracked_urls = trackedUrls;
      const prioritySources = listFlag(flags, "priority-sources");
      if (prioritySources) patch.priority_sources = prioritySources;
      const location = jsonObjectFlag(flags, "location-json");
      if (location) patch.location = location;
      if (flags.active === "true" || flags.active === true) {
        patch.is_active = true;
      }
      if (flags.active === "false" || flags.active === false) {
        patch.is_active = false;
      }
      if (Object.keys(patch).length === 0) {
        console.error(
          "Pass at least one field to update (--name, --criteria, --url, --cron, --active)",
        );
        Deno.exit(1);
      }
      const updated = await apiFetch<Scout>(`/functions/v1/scouts/${id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      printJSON(updated);
      return;
    }
    case "run":
    case "pause":
    case "resume": {
      const id = positional[0];
      if (!id) {
        console.error(`Usage: scout scouts ${sub} <id>`);
        Deno.exit(1);
      }
      const res = await apiFetch(`/functions/v1/scouts/${id}/${sub}`, {
        method: "POST",
      });
      printJSON(res);
      return;
    }
    case "delete": {
      const id = positional[0];
      if (!id) {
        console.error("Usage: scout scouts delete <id>");
        Deno.exit(1);
      }
      await apiFetch(`/functions/v1/scouts/${id}`, { method: "DELETE" });
      console.log(`Deleted scout ${id}`);
      return;
    }
    default:
      console.error(`Unknown subcommand: ${sub}`);
      usage();
      Deno.exit(1);
  }
}

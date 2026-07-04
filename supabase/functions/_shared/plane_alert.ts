/**
 * plane-alert-db CSV parsing + category mapping. Pure (no network/DB) so both
 * the refresh ops script and the CI test import it.
 *
 * Source: sdr-enthusiasts/plane-alert-db, ODbL 1.0 / DbCL 1.0 (verified
 * 2026-07-03). Derived rows inherit ODbL share-alike; attribution is shown in
 * the product (docs/features/transport.md).
 */

/** #CMPG group code → Scoutpost aircraft category filter value. */
export const CMPG_CATEGORY: Record<string, string> = {
  Mil: "military",
  Gov: "government",
  Pol: "police",
  Civ: "civil",
};

/** Aircraft watchlist categories a scout can filter on. */
export const AIRCRAFT_WATCHLIST_CATEGORIES = [
  "military",
  "government",
  "police",
  "civil",
] as const;

export interface WatchlistRow {
  ident_type: "icao_hex";
  ident: string;
  name: string | null;
  category: string;
  source: string;
  metadata: Record<string, unknown>;
}

/** Split one CSV line honoring double-quoted fields (which may contain
 * commas — the upstream $Link column sometimes is quoted). */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { // escaped quote
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

/**
 * Parse the plane-alert-db.csv text into watchlist rows. Columns:
 * $ICAO, $Registration, $Operator, $Type, $ICAO Type, #CMPG, tags..., Category, $Link
 * Rows with a non-6-hex ICAO or an unknown group code are skipped.
 */
export function parsePlaneAlertCsv(text: string): WatchlistRow[] {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const rows: WatchlistRow[] = [];
  for (const line of lines.slice(1)) { // skip header
    const c = splitCsvLine(line);
    if (c.length < 11) continue;
    const icao = c[0].trim().toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(icao)) continue;
    const category = CMPG_CATEGORY[c[5].trim()];
    if (!category) continue;
    rows.push({
      ident_type: "icao_hex",
      ident: icao,
      name: c[2].trim() || c[1].trim() || null,
      category,
      source: "plane-alert-db",
      metadata: {
        registration: c[1].trim() || null,
        operator: c[2].trim() || null,
        aircraft_type: c[3].trim() || null,
        plane_alert_category: c[9].trim() || null,
        link: c[10].trim() || null,
        license: "ODbL-1.0 / DbCL-1.0 (sdr-enthusiasts/plane-alert-db)",
      },
    });
  }
  return rows;
}

/** License guard: the README must still assert ODbL + DbCL. */
export function licenseTextIsOdbl(readmeText: string): boolean {
  const t = readmeText.toLowerCase();
  return t.includes("open database license") &&
    t.includes("database contents license");
}

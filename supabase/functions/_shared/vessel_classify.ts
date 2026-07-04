/**
 * AIS vessel classification + flag-state resolution.
 *
 * Written from public standards — ITU-R M.1371 ship-type codes and the ITU
 * Maritime Identification Digits (MID) table — NOT ported from any GPL/AGPL
 * source. Only the numeric ranges and MID→country assignments are used, which
 * are facts published by the ITU, not copyrightable expression.
 */

export type VesselClass =
  | "tanker"
  | "cargo"
  | "passenger"
  | "fishing"
  | "hsc" // high-speed craft
  | "tug_special" // tug, pilot, port tender, dredger, SAR, etc.
  | "pleasure"
  | "other"
  | "unknown";

/**
 * Map an ITU-R M.1371 ship-and-cargo type code to a rendering/filter class.
 * Ranges: 20-29 WIG, 30 fishing, 31-32 towing, 33 dredging, 34 diving,
 * 35 military, 36 sailing, 37 pleasure, 40-49 HSC, 50-59 special craft,
 * 60-69 passenger, 70-79 cargo, 80-89 tanker, 90-99 other.
 */
export function classifyByAisType(
  type: number | null | undefined,
): VesselClass {
  if (type == null || type <= 0) return "unknown";
  if (type >= 80 && type <= 89) return "tanker";
  if (type >= 70 && type <= 79) return "cargo";
  if (type >= 60 && type <= 69) return "passenger";
  if (type >= 40 && type <= 49) return "hsc";
  if (type === 30) return "fishing";
  if (type === 37) return "pleasure";
  if (type >= 31 && type <= 35) return "tug_special";
  if (type >= 50 && type <= 59) return "tug_special";
  return "other";
}

// Category filter (config.categories) → predicate over VesselClass.
export const VESSEL_CATEGORY_CLASSES: Record<string, VesselClass[]> = {
  tanker: ["tanker"],
  cargo: ["cargo"],
  passenger: ["passenger"],
  fishing: ["fishing"],
  military: [], // military uses a dedicated flag (AIS type 35), see below
};

/** ITU-R M.1371 assigns ship-type 35 to "Military ops". */
export function isMilitaryAisType(type: number | null | undefined): boolean {
  return type === 35;
}

/**
 * ITU Maritime Identification Digits: the first three digits of a 9-digit
 * MMSI identify the flag state. This is a representative subset covering the
 * flags most relevant to chokepoint monitoring; unknown MIDs resolve to null
 * (the vessel is still tracked, just without a flag label).
 */
const MID_COUNTRY: Record<string, string> = {
  "201": "Albania",
  "202": "Andorra",
  "203": "Austria",
  "205": "Belgium",
  "206": "Belarus",
  "207": "Bulgaria",
  "209": "Cyprus",
  "210": "Cyprus",
  "211": "Germany",
  "212": "Cyprus",
  "215": "Malta",
  "218": "Germany",
  "219": "Denmark",
  "220": "Denmark",
  "224": "Spain",
  "225": "Spain",
  "226": "France",
  "227": "France",
  "228": "France",
  "230": "Finland",
  "232": "United Kingdom",
  "233": "United Kingdom",
  "234": "United Kingdom",
  "235": "United Kingdom",
  "236": "Gibraltar",
  "237": "Greece",
  "238": "Croatia",
  "239": "Greece",
  "240": "Greece",
  "241": "Greece",
  "244": "Netherlands",
  "245": "Netherlands",
  "246": "Netherlands",
  "247": "Italy",
  "248": "Malta",
  "249": "Malta",
  "250": "Ireland",
  "253": "Luxembourg",
  "256": "Malta",
  "257": "Norway",
  "258": "Norway",
  "259": "Norway",
  "261": "Poland",
  "263": "Portugal",
  "265": "Sweden",
  "266": "Sweden",
  "269": "Switzerland",
  "271": "Turkey",
  "272": "Ukraine",
  "273": "Russia",
  "304": "Antigua and Barbuda",
  "305": "Antigua and Barbuda",
  "308": "Bahamas",
  "309": "Bahamas",
  "311": "Bahamas",
  "312": "Belize",
  "316": "Canada",
  "319": "Cayman Islands",
  "338": "United States",
  "341": "St Kitts and Nevis",
  "351": "Panama",
  "352": "Panama",
  "353": "Panama",
  "354": "Panama",
  "355": "Panama",
  "356": "Panama",
  "357": "Panama",
  "366": "United States",
  "367": "United States",
  "368": "United States",
  "369": "United States",
  "370": "Panama",
  "371": "Panama",
  "372": "Panama",
  "373": "Panama",
  "374": "Panama",
  "412": "China",
  "413": "China",
  "414": "China",
  "416": "Taiwan",
  "419": "India",
  "422": "Iran",
  "423": "Azerbaijan",
  "425": "Iraq",
  "428": "Israel",
  "431": "Japan",
  "432": "Japan",
  "440": "South Korea",
  "441": "South Korea",
  "445": "North Korea",
  "450": "Lebanon",
  "451": "Kyrgyzstan",
  "463": "Qatar",
  "466": "Kuwait",
  "470": "United Arab Emirates",
  "471": "United Arab Emirates",
  "473": "Yemen",
  "475": "Yemen",
  "477": "Hong Kong",
  "525": "Indonesia",
  "533": "Malaysia",
  "563": "Singapore",
  "564": "Singapore",
  "565": "Singapore",
  "566": "Singapore",
  "574": "Vietnam",
  "612": "Ivory Coast",
  "620": "Comoros",
  "636": "Liberia",
  "637": "Liberia",
  "657": "Nigeria",
  "667": "Sierra Leone",
  "710": "Brazil",
  "725": "Chile",
};

/** Resolve a vessel's flag state from its MMSI's Maritime Identification
 * Digits. Returns null when the MID is not in the table or the MMSI is
 * malformed. */
export function flagFromMmsi(
  mmsi: string | number | null | undefined,
): string | null {
  if (mmsi == null) return null;
  const digits = String(mmsi).trim();
  if (!/^\d{9}$/.test(digits)) return null;
  return MID_COUNTRY[digits.slice(0, 3)] ?? null;
}

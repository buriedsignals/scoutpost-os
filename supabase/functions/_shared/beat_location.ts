export interface BeatLocationShape {
  city: string | null;
  state: string | null;
  country: string | null;
  countryCode: string | null;
  displayName?: string | null;
}

const COUNTRY_ALIAS_MAP: Record<string, string[]> = {
  GB: [
    "united kingdom",
    "uk",
    "britain",
    "british",
    "england",
    "scotland",
    "wales",
    "northern ireland",
    "gov.uk",
  ],
  US: ["united states", "us", "usa", "american", ".gov"],
  CA: ["canada", "canadian", ".gc.ca"],
  AU: ["australia", "australian", ".gov.au"],
  NZ: ["new zealand", "nz", ".govt.nz"],
  IE: ["ireland", "irish", ".gov.ie"],
  FR: ["france", "french", ".gouv.fr"],
  DE: ["germany", "german", ".de"],
  CH: ["switzerland", "swiss", ".ch"],
};

export function parseBeatLocation(v: unknown): BeatLocationShape {
  if (!v) return emptyBeatLocation();
  if (typeof v === "string") {
    const parts = v.split(",").map((s) => s.trim());
    return {
      city: parts[0] || null,
      state: null,
      country: parts[1] || null,
      countryCode: null,
      displayName: v,
    };
  }
  if (typeof v !== "object") {
    return emptyBeatLocation();
  }

  const rec = v as Record<string, unknown>;
  const displayName = pickString(rec.displayName, rec.display_name, rec.label);
  const locationType = pickString(rec.locationType, rec.location_type);
  const displayPrimary = displayName?.split(",")[0]?.trim() || null;
  // LocationAutocomplete sends MapTiler region/subregion selections as
  // locationType="state" with no city; keep the display region as the
  // searchable location name.
  const city = locationType === "country" ? null : pickString(rec.city) ??
    (locationType === "state" ? displayPrimary : null);
  const state = pickString(rec.state, rec.region, rec.admin1);
  const rawCountry = pickString(rec.country, rec.country_name);
  const explicitCountryCode = pickString(rec.country_code, rec.countryCode);
  const displayCountry = displayName && city && displayName.includes(",")
    ? displayName
      .split(",")
      .slice(1)
      .join(",")
      .trim() || null
    : null;
  const inferredCountryCode = rawCountry && /^[A-Za-z]{2,3}$/.test(rawCountry)
    ? rawCountry.toUpperCase()
    : null;
  const countryCode = explicitCountryCode?.toUpperCase() ?? inferredCountryCode;
  const country = rawCountry && !/^[A-Za-z]{2,3}$/.test(rawCountry)
    ? rawCountry
    : locationType === "country" && displayName
    ? displayName
    : displayCountry;
  return { city, state, country, countryCode, displayName };
}

export function buildBeatLocationSearchLabel(
  location: BeatLocationShape,
): string | null {
  const city = cleanLocationPart(location.city);
  const state = cleanLocationPart(location.state);
  const displayAdmin = displayAdminPart(location.displayName, city);
  const country = cleanLocationPart(location.country);
  if (!city) return country;

  const admin = firstJurisdictionPart(country);
  const disambiguator = displayAdmin && !samePlaceName(displayAdmin, city)
    ? displayAdmin
    : state && !samePlaceName(state, city)
    ? state
    : admin && !samePlaceName(admin, city)
    ? admin
    : country && !samePlaceName(country, city)
    ? country
    : null;
  if (!disambiguator) return city;
  return `${city} ${disambiguator}`.slice(0, 160);
}

export function buildBeatLocationMatcher(
  location: BeatLocationShape,
): ((text: string) => boolean) | null {
  const cityAliases = location.city ? [location.city] : [];
  const jurisdictionAliases = location.city
    ? buildJurisdictionAliases(location)
    : [];
  const countryAliases = location.countryCode
    ? [...(COUNTRY_ALIAS_MAP[location.countryCode] ?? [])]
    : [];
  if (
    location.country && !countryAliases.includes(location.country.toLowerCase())
  ) {
    countryAliases.unshift(location.country);
  }

  if (cityAliases.length === 0 && countryAliases.length === 0) {
    return null;
  }

  return (text: string) => {
    const hasCity = cityAliases.some((alias) => containsAlias(text, alias));
    const hasJurisdiction = jurisdictionAliases.some((alias) =>
      containsAlias(text, alias)
    );
    const hasCountry = countryAliases.some((alias) =>
      containsAlias(text, alias)
    );
    if (cityAliases.length > 0 && jurisdictionAliases.length > 0) {
      return hasCity && hasJurisdiction;
    }
    if (cityAliases.length > 0) return hasCity || hasCountry;
    return hasCountry;
  };
}

function pickString(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return null;
}

function emptyBeatLocation(): BeatLocationShape {
  return {
    city: null,
    state: null,
    country: null,
    countryCode: null,
    displayName: null,
  };
}

function cleanLocationPart(value: string | null | undefined): string | null {
  const cleaned = (value ?? "").replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ")
    .trim();
  return cleaned || null;
}

function firstJurisdictionPart(
  value: string | null | undefined,
): string | null {
  return cleanLocationPart(value?.split(",")[0] ?? null);
}

function displayAdminPart(
  displayName: string | null | undefined,
  city: string | null,
): string | null {
  if (!displayName || !city) return null;
  const parts = displayName.split(",").map((part) => cleanLocationPart(part))
    .filter((part): part is string => Boolean(part));
  if (parts.length < 2 || !samePlaceName(parts[0], city)) return null;
  return parts[1];
}

function buildJurisdictionAliases(location: BeatLocationShape): string[] {
  const displayAdmin = displayAdminPart(location.displayName, location.city);
  const stateAlias = usefulJurisdictionAlias(location.state);
  const hasSubdivisionSignal = Boolean(
    stateAlias || displayNameHasSubdivision(location.displayName) ||
      location.country?.includes(","),
  );
  if (!hasSubdivisionSignal) return [];

  const aliases = [
    displayAdmin,
    stateAlias,
    firstJurisdictionPart(location.country),
    location.countryCode ? COUNTRY_ALIAS_MAP[location.countryCode] ?? [] : [],
    location.country,
  ].flat().filter((alias): alias is string => Boolean(alias));
  return [...new Set(aliases.map((alias) => alias.trim()).filter(Boolean))];
}

function usefulJurisdictionAlias(
  value: string | null | undefined,
): string | null {
  const cleaned = cleanLocationPart(value);
  return cleaned && cleaned.length > 2 ? cleaned : null;
}

function displayNameHasSubdivision(
  displayName: string | null | undefined,
): boolean {
  return (displayName?.split(",").length ?? 0) > 2;
}

function samePlaceName(a: string, b: string): boolean {
  return normalizeText(a) === normalizeText(b);
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsAlias(text: string, alias: string): boolean {
  const haystack = normalizeText(text);
  const needle = normalizeText(alias);
  if (!needle) return false;
  if (needle.includes(".") || needle.includes("/")) {
    return haystack.includes(needle);
  }
  const pattern = new RegExp(`(^|[^a-z])${escapeRegex(needle)}([^a-z]|$)`);
  return pattern.test(haystack);
}

/**
 * Transport Scout UI helpers — per-mode categories, watch-ID validation and
 * ID lookup sources. New Fleet scouts use a MapTiler-selected center plus an
 * explicit radius; legacy presets remain runtime-only in the backend.
 */
import * as m from '$lib/paraglide/messages';

export function getTransportCategoryLabel(category: string): string {
	switch (category) {
		case 'military': return m.transport_categoryMilitary();
		case 'government': return m.pulse_government();
		case 'police': return m.transport_categoryPolice();
		case 'civil': return m.transport_categoryCivil();
		case 'tanker': return m.transport_categoryTanker();
		case 'cargo': return m.transport_categoryCargo();
		case 'passenger': return m.transport_categoryPassenger();
		case 'fishing': return m.transport_categoryFishing();
		case 'pleasure': return m.transport_categoryPleasure();
		default: return category;
	}
}

export type TransportMode = 'aircraft' | 'vessel';

/** Max watch IDs per scout — mirrors MAX_WATCH_IDS in
 * supabase/functions/_shared/transport_config.ts (product decision
 * 2026-07-06); alert emails cap their cards at the same number. */
export const TRANSPORT_MAX_WATCH_IDS = 20;

// Client-side ID validators mirroring _shared/transport_config.ts, so users
// get inline errors instead of confusing server 400s.
const VESSEL_MMSI_RE = /^[2-7]\d{8}$/;
const ICAO_HEX_RE = /^[0-9a-f]{6}$/;

/** Locale-tolerant number parse — accepts both '12.5' and '12,5'. */
export function transportParseNum(s: string): number {
	return Number(s.trim().replace(',', '.'));
}

/** Validate a watch ID for the given mode (already lowercased/trimmed). */
export function transportWatchIdValid(mode: TransportMode, id: string): boolean {
	if (mode === 'vessel') return VESSEL_MMSI_RE.test(id);
	if (mode === 'aircraft') return ICAO_HEX_RE.test(id);
	return false;
}

/** Category filter options per mode — these only NARROW the watch list, they
 * cannot replace it. Values must
 * be real classifier outputs (_shared/vessel_classify.ts / plane_alert.ts) —
 * 'yacht' was never emitted; the AIS pleasure-craft class is 'pleasure'. */
export function transportModeCategories(mode: TransportMode): string[] {
	if (mode === 'aircraft') return ['military', 'government', 'police', 'civil'];
	if (mode === 'vessel') return ['military', 'tanker', 'cargo', 'passenger', 'fishing', 'pleasure'];
	return [];
}

/** Where users can look up trackable IDs, per mode — linked below the
 * watch-IDs field. */
export const TRANSPORT_ID_SOURCES: Record<
	TransportMode,
	{ label: string; url: string }
> = {
	vessel: { label: 'MarineTraffic', url: 'https://www.marinetraffic.com/' },
	aircraft: { label: 'ADS-B Exchange', url: 'https://globe.adsbexchange.com/' },
};

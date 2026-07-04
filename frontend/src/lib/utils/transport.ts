/**
 * Transport Scout UI helpers — presets, per-mode categories, and the
 * per-mode schedule window. The preset list mirrors the seeded
 * transport_geofence_presets table (migration 00072); it is stable seed
 * data, so it is duplicated here rather than fetched to keep the panel simple.
 */

export interface TransportPreset {
	id: string;
	name: string;
}

export const TRANSPORT_PRESETS: TransportPreset[] = [
	{ id: 'strait-of-hormuz', name: 'Strait of Hormuz' },
	{ id: 'bab-el-mandeb', name: 'Bab-el-Mandeb' },
	{ id: 'suez-approaches', name: 'Suez Canal approaches' },
	{ id: 'strait-of-malacca', name: 'Strait of Malacca' },
	{ id: 'taiwan-strait', name: 'Taiwan Strait' },
	{ id: 'spratly-box', name: 'Spratly Islands box' },
	{ id: 'bosphorus', name: 'Bosphorus' },
	{ id: 'kerch-strait', name: 'Kerch Strait' },
	{ id: 'black-sea-grain-corridor', name: 'Black Sea grain corridor' },
	{ id: 'dover-strait', name: 'Dover Strait' },
	{ id: 'strait-of-gibraltar', name: 'Strait of Gibraltar' },
	{ id: 'danish-straits', name: 'Danish Straits' },
	{ id: 'gulf-of-finland', name: 'Gulf of Finland' },
	{ id: 'panama-approaches', name: 'Panama Canal approaches' },
	{ id: 'cape-of-good-hope', name: 'Cape of Good Hope corridor' }
];

export type TransportMode = 'aircraft' | 'vessel' | 'satellite';

// Client-side ID validators mirroring _shared/transport_config.ts, so users
// get inline errors instead of confusing server 400s.
const VESSEL_MMSI_RE = /^[2-7]\d{8}$/;
const ICAO_HEX_RE = /^[0-9a-f]{6}$/;
const NORAD_RE = /^[1-9]\d{0,8}$/;

/** Locale-tolerant number parse — accepts both '12.5' and '12,5'. */
export function transportParseNum(s: string): number {
	return Number(s.trim().replace(',', '.'));
}

/** Validate a watch ID for the given mode (already lowercased/trimmed). */
export function transportWatchIdValid(mode: TransportMode, id: string): boolean {
	if (mode === 'vessel') return VESSEL_MMSI_RE.test(id);
	if (mode === 'aircraft') return ICAO_HEX_RE.test(id);
	return NORAD_RE.test(id);
}

/** Category filter options per mode — these only NARROW the watch list, they
 * cannot replace it. Satellites have no category filters in v1. Values must
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
	satellite: { label: 'CelesTrak SATCAT', url: 'https://celestrak.org/satcat/search.php' }
};

export interface RegularityOption {
	value: '3h' | '6h' | '12h' | 'daily';
	label: string;
}

/** Schedule window per mode — satellites are daily-only (passes are
 * predicted a day ahead); aircraft/vessel run 3h/6h/12h/daily. */
export function transportRegularities(mode: TransportMode): RegularityOption[] {
	const daily: RegularityOption = { value: 'daily', label: 'Daily' };
	if (mode === 'satellite') return [daily];
	return [
		{ value: '3h', label: 'Every 3 hours' },
		{ value: '6h', label: 'Every 6 hours' },
		{ value: '12h', label: 'Every 12 hours' },
		daily
	];
}

/**
 * Utilities for rendering unit (information unit) fields in the UI.
 */
import * as m from '$lib/paraglide/messages';

export function getUnitTypeLabel(unitType: string | null | undefined): string {
	switch (unitType?.toLowerCase()) {
		case 'promise': return m.unit_typePromise();
		case 'fact': return m.unit_typeFact();
		case 'event': return m.unit_typeEvent();
		case 'quote': return m.unit_typeQuote();
		case 'announcement': return m.unit_typeAnnouncement();
		case 'claim': return m.unit_typeClaim();
		case 'decision': return m.civic_materialDecision();
		case 'location': return m.filter_location();
		case 'civic': return m.scoutType_civicMonitor();
		case 'beat':
		case 'pulse': return m.scoutType_smartMonitor();
		case 'page':
		case 'web': return m.scoutType_pageMonitor();
		case 'social': return m.scoutType_socialMonitor();
		default: return unitType || m.unit_typeUnit();
	}
}

/**
 * Strip redundant "X extracted: " prefixes from a unit's statement so the
 * type-badge pill carries that information and the statement itself reads
 * as the raw claim. Example:
 *
 *   "Promise extracted: \"We commit to …\" — Mayor, page 14"
 *   → "\"We commit to …\" — Mayor, page 14"
 *
 * The prefixes mirror the types the AI extraction pipeline emits (civic
 * promises, facts, events, quotes, announcements). If a user ever wants
 * the prefix back inline, remove this helper's usage in UnitRow/UnitDrawer.
 */
export function cleanUnitStatement(statement: string | null | undefined): string {
	if (!statement) return '';
	return statement.replace(/^(Promise|Fact|Event|Quote|Announcement|Claim)\s+extracted:\s*/i, '');
}

/**
 * Per-unit-type badge style: background + text color. Values are CSS
 * `var(--…)` strings so they render via inline `style=` in both UnitRow
 * and UnitDrawer without duplicating the palette mapping.
 *
 * Civic / beat / pulse / location → moonlight. Page / web / social → pond.
 */
export interface UnitTypeStyle {
	background: string;
	color: string;
}

const MOONLIGHT_STYLE: UnitTypeStyle = {
	background: 'oklch(0.87 0.025 205 / 12%)',
	color: 'oklch(0.87 0.025 205)'
};

const POND_STYLE: UnitTypeStyle = {
	background: 'var(--color-secondary-soft)',
	color: 'oklch(0.72 0.06 200)'
};

const NEUTRAL_STYLE: UnitTypeStyle = {
	background: 'var(--color-surface)',
	color: 'var(--color-ink-muted)'
};

const UNIT_TYPE_STYLES: Record<string, UnitTypeStyle> = {
	CIVIC: MOONLIGHT_STYLE,
	BEAT: MOONLIGHT_STYLE,
	PULSE: MOONLIGHT_STYLE,
	LOCATION: MOONLIGHT_STYLE,
	PAGE: POND_STYLE,
	WEB: POND_STYLE,
	SOCIAL: POND_STYLE
};

export function getUnitTypeStyle(unitType: string | null | undefined): UnitTypeStyle {
	if (!unitType) return NEUTRAL_STYLE;
	return UNIT_TYPE_STYLES[unitType.toUpperCase()] ?? NEUTRAL_STYLE;
}

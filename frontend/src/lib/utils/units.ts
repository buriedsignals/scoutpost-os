/**
 * Utilities for rendering unit (information unit) fields in the UI.
 */

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

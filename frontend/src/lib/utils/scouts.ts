/**
 * Scout Utilities -- pure functions for scout card display and status logic.
 *
 * USED BY: ScoutScheduleModal.svelte, workspace components,
 *          tests/utils/scouts.test.ts
 * DEPENDS ON: $lib/types (ScoutType)
 *
 * Shared scout UI logic. Contains credit costs,
 * schedule formatting, URL truncation, markdown stripping, and the
 * consolidated scout status cascade (priority-ordered condition matching).
 */

import type { ComponentType } from 'svelte';
import { Globe, Radar, Users, Landmark, Navigation } from 'lucide-svelte';
import type { ScoutType } from '$lib/types';

export type ScoutTypeLike = ScoutType | 'beat' | 'page' | 'location' | string;

/**
 * Per-scout-type display config: the icon for the eyebrow glyph, the CSS
 * className used to wire up the left-stripe + eyebrow color ("web" and
 * "pulse" take plum; "social" and "civic" take ochre), and the human label.
 *
 * Single source of truth for ScoutCard, ScoutFocus, and NewScoutDropdown.
 */
export interface ScoutTypeDisplay {
	icon: ComponentType;
	className: 'web' | 'pulse' | 'social' | 'civic';
	label: string;
}

export const SCOUT_TYPE_CONFIG: Record<ScoutType, ScoutTypeDisplay> = {
	web:    { icon: Globe,    className: 'web',    label: 'Page Monitor' },
	pulse:  { icon: Radar,    className: 'pulse',  label: 'Beat Monitor' },
	social: { icon: Users,    className: 'social', label: 'Social Monitor' },
	civic:  { icon: Landmark, className: 'civic',  label: 'Civic Monitor' },
	// Registered ahead of the full Transport panel so API-created transport
	// scouts render with the right identity instead of falling back to the
	// Page Monitor display + editor. Borrows the 'web' stripe styling until
	// the dedicated panel ships.
	transport: { icon: Navigation, className: 'web', label: 'Fleet Monitor' }
};

const DEFAULT_SCOUT_DISPLAY: ScoutTypeDisplay = {
	icon: Globe,
	className: 'web',
	label: 'Scout'
};

export function normalizeScoutType(type: ScoutTypeLike | null | undefined): ScoutType {
	switch (type) {
		case 'beat':
		case 'location':
			return 'pulse';
		case 'page':
			return 'web';
		case 'web':
		case 'pulse':
		case 'social':
		case 'civic':
		case 'transport':
			return type;
		default:
			return 'web';
	}
}

export function getScoutTypeDisplay(type: ScoutTypeLike | null | undefined): ScoutTypeDisplay {
	if (!type) return DEFAULT_SCOUT_DISPLAY;
	if (type in SCOUT_TYPE_CONFIG) {
		return SCOUT_TYPE_CONFIG[type as ScoutType];
	}
	const normalized = normalizeScoutType(type);
	return SCOUT_TYPE_CONFIG[normalized] ?? DEFAULT_SCOUT_DISPLAY;
}

/** Credit costs per scout type (see supabase/functions/_shared/credits.ts:CREDIT_COSTS) */
export const SCOUT_COSTS: Record<ScoutType, number> = {
	// Beat and civic scouts are capped at weekly/monthly schedules.
	civic: 10,
	pulse: 7,
	social: 2, // Base cost (Instagram/X/TikTok). Facebook is 15.
	web: 1,
	transport: 1 // +1 with free-text criteria (charged server-side)
};

/** Platform-specific costs for social scouts */
export const SOCIAL_SCOUT_COSTS: Record<string, number> = {
	instagram: 2,
	x: 2,
	twitter: 2,
	facebook: 15,
	tiktok: 2
};

/** Get credit cost for a scout, with platform awareness for social scouts. */
export function getScoutCost(type: ScoutTypeLike, platform?: string): number {
	const canonicalType = normalizeScoutType(type);
	if (canonicalType === 'social' && platform) {
		return SOCIAL_SCOUT_COSTS[platform] ?? SCOUT_COSTS.social;
	}
	return SCOUT_COSTS[canonicalType] ?? 1;
}

/** Regularity → number of runs per month. Mirrors calculateMonitoringCost in
 * supabase/functions/_shared/credits.ts — every regularity the backend
 * permits must be priced here or the credit pre-check under-estimates. */
const REGULARITY_MULTIPLIERS: Record<string, number> = {
	'3h': 240,
	'6h': 120,
	'12h': 60,
	daily: 30,
	weekly: 4,
	monthly: 1
};

export function getRegularityMultiplier(
	regularity: 'daily' | 'weekly' | 'monthly' | '3h' | '6h' | '12h' | string
): number {
	return REGULARITY_MULTIPLIERS[regularity] ?? 1;
}

/**
 * Client-side credit pre-check for scout scheduling. Replaces the dead network
 * call to POST /scrapers/monitoring/validate (FastAPI-only, 404s in Supabase
 * mode). The authoritative charge still happens inside each executor Edge
 * Function via decrement_credits — this is UX only.
 *
 * Flat getScoutCost() applies even for pulse+niche+location, matching
 * scout-beat-execute/index.ts:153 (server of record), not the prod UI's
 * cosmetic 10-credit override.
 */
export function validateScheduleCredits(params: {
	scoutType: ScoutType;
	// Transport allows sub-daily (3h/6h/12h); getRegularityMultiplier prices all.
	regularity: 'daily' | 'weekly' | 'monthly' | '3h' | '6h' | '12h';
	platform?: string;
	currentCredits: number;
	/** Extra credits per run on top of the base cost (e.g. transport's +1
	 * free-text-criteria addon). Must match what the UI displays, or the gate
	 * under-budgets and the scout runs out of credits mid-month. */
	perRunAddon?: number;
}): {
	valid: boolean;
	perRunCost: number;
	monthlyCost: number;
	currentCredits: number;
	remainingAfter: number;
} {
	const perRunCost = getScoutCost(params.scoutType, params.platform) +
		(params.perRunAddon ?? 0);
	const monthlyCost = perRunCost * getRegularityMultiplier(params.regularity);
	return {
		valid: params.currentCredits >= monthlyCost,
		perRunCost,
		monthlyCost,
		currentCredits: params.currentCredits,
		remainingAfter: params.currentCredits - monthlyCost
	};
}

/** Channel-specific costs for data extraction */
export const EXTRACT_COSTS: Record<string, number> = {
	website: 1,
	social: 2,
	instagram: 2,
	facebook: 15,
	tiktok: 2,
	instagram_comments: 15
};

/** Format a regularity + time into a human-readable schedule string. */
export function formatRegularity(regularity: string, time?: string): string {
	if (regularity === 'weekly') return 'Weekly';
	if (regularity === 'monthly') return 'Monthly';

	if (regularity === 'daily' && time) {
		const [hourStr, minuteStr] = time.split(':');
		const hour = parseInt(hourStr, 10);
		const minute = parseInt(minuteStr, 10);
		const period = hour >= 12 ? 'PM' : 'AM';
		const displayHour = hour % 12 || 12;
		const displayTime =
			minute === 0 ? `${displayHour}${period}` : `${displayHour}:${minuteStr}${period}`;
		return `Daily at ${displayTime}`;
	}

	return regularity.charAt(0).toUpperCase() + regularity.slice(1);
}

/** Truncate a URL for display, showing hostname + path. */
export function truncateUrl(url: string, maxLength = 40): string {
	try {
		const parsed = new URL(url);
		const display = parsed.hostname + parsed.pathname;
		return display.length > maxLength ? display.slice(0, maxLength - 3) + '...' : display;
	} catch {
		return url.length > maxLength ? url.slice(0, maxLength - 3) + '...' : url;
	}
}

/** Strip markdown formatting from text for cleaner card display. */
export function stripMarkdown(text: string): string {
	if (!text) return '';
	return (
		text
			.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [text](url) → text
			.replace(/\*\*([^*]+)\*\*/g, '$1') // bold (before bullets)
			.replace(/\*([^*]+)\*/g, '$1') // italic (before bullets)
			.replace(/^[•\-*]\s*/gm, '') // bullets
			.replace(/#{1,6}\s*/g, '') // headers
			.replace(/\s+/g, ' ') // collapse whitespace
			.trim()
			.slice(0, 150) + (text.length > 150 ? '...' : '')
	);
}

/**
 * Consolidated scout status system.
 * Single pill replaces the old two-badge (execution + criteria) approach.
 * */

export type StatusVariant = 'success' | 'error' | 'neutral' | 'warning' | 'waiting';

export type StatusKey =
	| 'awaitingFirstRun'
	| 'running'
	| 'skipped'
	| 'runFailed'
	| 'newFindings'
	| 'alreadyKnown'
	| 'match'
	| 'noChanges'
	| 'noMatch'
	| 'noSavedFindings';

/** Scout data needed for status display. */
export interface ScoutStatusInput {
	type: ScoutType;
	last_run?: {
		started_at?: string | null;
		status?: string | null;
		articles_count?: number | null;
		merged_existing_count?: number | null;
		scraper_status?: boolean | null;
		criteria_status?: boolean | null;
		card_summary?: string;
	} | null;
}

export interface ScoutStatusResult {
	variant: StatusVariant;
	key: StatusKey;
}

export const SCOUT_STATUS_LABELS: Record<StatusKey, string> = {
	awaitingFirstRun: 'Awaiting first run',
	running: 'Running',
	skipped: 'Skipped',
	runFailed: 'Run failed',
	newFindings: 'New findings',
	alreadyKnown: 'Already known',
	match: 'Criteria matched',
	noChanges: 'No changes',
	noMatch: 'No criteria match',
	noSavedFindings: 'No findings saved'
};

export function getScoutStatusLabel(status: ScoutStatusResult | StatusKey): string {
	const key = typeof status === 'string' ? status : status.key;
	return SCOUT_STATUS_LABELS[key];
}

/**
 * Status config: priority cascade for the single status pill.
 * Each entry has a condition function, the i18n key suffix, and the visual variant.
 * Evaluated in order — first match wins.
 */
const STATUS_CASCADE: Array<{
	key: StatusKey;
	variant: StatusVariant;
	match: (input: ScoutStatusInput) => boolean;
}> = [
	// Priority 1: No run yet
	{
		key: 'awaitingFirstRun',
		variant: 'waiting',
		match: (s) => !s.last_run || ('started_at' in s.last_run && !s.last_run.started_at),
	},
	// Priority 2a: Execution in progress
	{
		key: 'running',
		variant: 'waiting',
		match: (s) => s.last_run?.status === 'running' || s.last_run?.status === 'queued',
	},
	// Priority 2a2: Run skipped (e.g. transport sampler/GP stale, or a
	// duplicate concurrent run). Not a failure — the scout is healthy and
	// resumes automatically. Matched BEFORE runFailed because a skipped run
	// carries scraper_status=false, which the failure rule would otherwise
	// catch.
	{
		key: 'skipped',
		variant: 'neutral',
		match: (s) => s.last_run?.status === 'skipped',
	},
	// Priority 2b: Execution failed
	{
		key: 'runFailed',
		variant: 'error',
		match: (s) =>
			s.last_run?.scraper_status === false ||
			s.last_run?.status === 'failed' ||
			s.last_run?.status === 'error',
	},
	// Priority 3a: Units were saved by the latest run
	{
		key: 'newFindings',
		variant: 'success',
		match: (s) => (s.last_run?.articles_count ?? 0) > 0,
	},
	// Priority 3b: The run found only facts already present in the inbox
	{
		key: 'alreadyKnown',
		variant: 'neutral',
		match: (s) =>
			(s.last_run?.articles_count ?? 0) === 0 &&
			(s.last_run?.merged_existing_count ?? 0) > 0,
	},
	// Priority 3c: Criteria matched — pulse, social, or civic
	{
		key: 'newFindings',
		variant: 'success',
		match: (s) => s.last_run?.criteria_status === true && (s.type === 'pulse' || s.type === 'social' || s.type === 'civic'),
	},
	// Priority 3d: Criteria matched — web
	{
		key: 'match',
		variant: 'success',
		match: (s) => s.last_run?.criteria_status === true && s.type === 'web',
	},
	// Priority 4a: Web scout — no changes detected
	{
		key: 'noChanges',
		variant: 'neutral',
		match: (s) => s.type === 'web' && s.last_run?.card_summary?.toLowerCase().includes('no changes') === true,
	},
	// Priority 4b: Workspace runs report saved-unit counts but not criteria detail.
	{
		key: 'noSavedFindings',
		variant: 'neutral',
		match: (s) => s.last_run !== null && s.last_run !== undefined && 'articles_count' in s.last_run,
	},
	// Priority 4c: Web scout — changes detected but criteria not met
	{
		key: 'noMatch',
		variant: 'warning',
		match: (s) => s.type === 'web',
	},
	// Priority 4d: pulse — no new results
	{
		key: 'noChanges',
		variant: 'neutral',
		match: () => true,
	},
];

/**
 * Get the consolidated status for a scout card.
 * Returns a variant for styling and a key for i18n lookup.
 */
export function getScoutStatus(scout: ScoutStatusInput): ScoutStatusResult {
	for (const entry of STATUS_CASCADE) {
		if (entry.match(scout)) {
			return { variant: entry.variant, key: entry.key };
		}
	}
	// Unreachable — last entry always matches
	return { variant: 'neutral', key: 'noChanges' };
}

/**
 * Tests for shared scout utility functions.
 * Pure logic tests — no Svelte rendering needed.
 */
import { describe, it, expect } from 'vitest';
import {
	SCOUT_COSTS,
	SOCIAL_SCOUT_COSTS,
	EXTRACT_COSTS,
	getScoutCost,
	normalizeScoutType,
	getScoutTypeDisplay,
	formatRegularity,
	truncateUrl,
	stripMarkdown,
	getScoutStatus,
	getScoutStatusLabel,
	type ScoutStatusInput
} from '$lib/utils/scouts';

// ===========================================================================
// SCOUT_COSTS
// ===========================================================================

describe('SCOUT_COSTS', () => {
	it('web scouts cost 1 credit', () => {
		expect(SCOUT_COSTS.web).toBe(1);
	});

	it('pulse scouts cost 7 credits', () => {
		expect(SCOUT_COSTS.pulse).toBe(7);
	});

	it('social scouts base cost is 2 credits', () => {
		expect(SCOUT_COSTS.social).toBe(2);
	});

	it('all scout types have costs', () => {
		expect(Object.keys(SCOUT_COSTS).sort()).toEqual(['civic', 'pulse', 'social', 'web']);
	});
});

describe('getScoutCost', () => {
	it('returns base cost for non-social types', () => {
		expect(getScoutCost('web')).toBe(1);
		expect(getScoutCost('pulse')).toBe(7);
	});

	it('accepts legacy beat aliases from live data', () => {
		expect(normalizeScoutType('beat')).toBe('pulse');
		expect(getScoutCost('beat')).toBe(7);
		expect(getScoutTypeDisplay('beat').label).toBe('Beat Monitor');
	});

	it('returns platform-specific cost for social scouts', () => {
		expect(getScoutCost('social', 'instagram')).toBe(2);
		expect(getScoutCost('social', 'x')).toBe(2);
		expect(getScoutCost('social', 'facebook')).toBe(15);
		expect(getScoutCost('social', 'tiktok')).toBe(2);
	});

	it('falls back to base social cost for unknown platform', () => {
		expect(getScoutCost('social', 'myspace')).toBe(2);
	});

	it('returns base social cost when no platform given', () => {
		expect(getScoutCost('social')).toBe(2);
	});
});

describe('SOCIAL_SCOUT_COSTS', () => {
	it('instagram costs 2', () => expect(SOCIAL_SCOUT_COSTS.instagram).toBe(2));
	it('x costs 2', () => expect(SOCIAL_SCOUT_COSTS.x).toBe(2));
	it('facebook costs 15', () => expect(SOCIAL_SCOUT_COSTS.facebook).toBe(15));
});

describe('EXTRACT_COSTS', () => {
	it('website costs 1', () => expect(EXTRACT_COSTS.website).toBe(1));
	it('social (X) costs 2', () => expect(EXTRACT_COSTS.social).toBe(2));
	it('instagram costs 2', () => expect(EXTRACT_COSTS.instagram).toBe(2));
	it('facebook costs 15', () => expect(EXTRACT_COSTS.facebook).toBe(15));
	it('instagram_comments costs 15', () => expect(EXTRACT_COSTS.instagram_comments).toBe(15));
});

// ===========================================================================
// formatRegularity
// ===========================================================================

describe('formatRegularity', () => {
	it('weekly returns "Weekly"', () => {
		expect(formatRegularity('weekly')).toBe('Weekly');
	});

	it('monthly returns "Monthly"', () => {
		expect(formatRegularity('monthly')).toBe('Monthly');
	});

	it('daily with morning time', () => {
		expect(formatRegularity('daily', '09:00')).toBe('Daily at 9AM');
	});

	it('daily with afternoon time', () => {
		expect(formatRegularity('daily', '14:30')).toBe('Daily at 2:30PM');
	});

	it('daily with midnight', () => {
		expect(formatRegularity('daily', '00:00')).toBe('Daily at 12AM');
	});

	it('daily with noon', () => {
		expect(formatRegularity('daily', '12:00')).toBe('Daily at 12PM');
	});

	it('daily with minutes shows full time', () => {
		expect(formatRegularity('daily', '08:15')).toBe('Daily at 8:15AM');
	});

	it('daily without time falls through to capitalize', () => {
		expect(formatRegularity('daily')).toBe('Daily');
	});

	it('unknown regularity gets capitalized', () => {
		expect(formatRegularity('biweekly')).toBe('Biweekly');
	});
});

// ===========================================================================
// truncateUrl
// ===========================================================================

describe('truncateUrl', () => {
	it('short URL stays unchanged', () => {
		expect(truncateUrl('https://example.com/page')).toBe('example.com/page');
	});

	it('long URL gets truncated', () => {
		const long = 'https://example.com/very/long/path/that/exceeds/the/maximum/length/allowed';
		const result = truncateUrl(long);
		expect(result.length).toBeLessThanOrEqual(40);
		expect(result).toMatch(/\.\.\.$/);
	});

	it('custom maxLength is respected', () => {
		const result = truncateUrl('https://example.com/some/path', 20);
		expect(result.length).toBeLessThanOrEqual(20);
	});

	it('invalid URL falls back to string truncation', () => {
		expect(truncateUrl('not-a-url')).toBe('not-a-url');
	});

	it('invalid URL that is long gets truncated', () => {
		const long = 'a'.repeat(50);
		const result = truncateUrl(long);
		expect(result.length).toBeLessThanOrEqual(40);
		expect(result).toMatch(/\.\.\.$/);
	});
});

// ===========================================================================
// stripMarkdown
// ===========================================================================

describe('stripMarkdown', () => {
	it('empty string returns empty', () => {
		expect(stripMarkdown('')).toBe('');
	});

	it('strips markdown links', () => {
		expect(stripMarkdown('[Click here](https://example.com)')).toBe('Click here');
	});

	it('strips bold', () => {
		expect(stripMarkdown('**important** text')).toBe('important text');
	});

	it('strips italic', () => {
		expect(stripMarkdown('*emphasized* text')).toBe('emphasized text');
	});

	it('strips headers', () => {
		expect(stripMarkdown('## Heading\nContent')).toBe('Heading Content');
	});

	it('strips bullet points', () => {
		expect(stripMarkdown('- item one\n- item two')).toBe('item one item two');
	});

	it('truncates to 150 chars with ellipsis', () => {
		const long = 'word '.repeat(50);
		const result = stripMarkdown(long);
		expect(result.length).toBeLessThanOrEqual(153); // 150 + "..."
		expect(result).toMatch(/\.\.\.$/);
	});

	it('short text has no ellipsis', () => {
		expect(stripMarkdown('Short text')).toBe('Short text');
	});
});

// ===========================================================================
// getScoutStatus — consolidated single-pill status
// ===========================================================================

describe('getScoutStatus', () => {
	// Priority 1: No run yet
	it('no last_run → awaiting first run (waiting)', () => {
		const scout: ScoutStatusInput = { type: 'web', last_run: null };
		expect(getScoutStatus(scout)).toEqual({ variant: 'waiting', key: 'awaitingFirstRun' });
	});

	it('undefined last_run → awaiting first run', () => {
		const scout: ScoutStatusInput = { type: 'pulse' };
		expect(getScoutStatus(scout)).toEqual({ variant: 'waiting', key: 'awaitingFirstRun' });
	});

	it('workspace last_run without started_at → awaiting first run', () => {
		const scout: ScoutStatusInput = {
			type: 'web',
			last_run: { started_at: null, status: null, articles_count: 0 }
		};
		expect(getScoutStatus(scout)).toEqual({ variant: 'waiting', key: 'awaitingFirstRun' });
	});

	it('queued workspace run → running (waiting)', () => {
		const scout: ScoutStatusInput = {
			type: 'web',
			last_run: { started_at: '2026-05-07T08:00:00Z', status: 'queued', articles_count: 0 }
		};
		expect(getScoutStatus(scout)).toEqual({ variant: 'waiting', key: 'running' });
	});

	// Priority 2: Execution failed
	it('scraper_status false → run failed (error)', () => {
		const scout: ScoutStatusInput = {
			type: 'web',
			last_run: { scraper_status: false, criteria_status: false }
		};
		expect(getScoutStatus(scout)).toEqual({ variant: 'error', key: 'runFailed' });
	});

	it('scraper_status false for pulse → run failed (error)', () => {
		const scout: ScoutStatusInput = {
			type: 'pulse',
			last_run: { scraper_status: false, criteria_status: false }
		};
		expect(getScoutStatus(scout)).toEqual({ variant: 'error', key: 'runFailed' });
	});

	it('failed workspace run → run failed (error)', () => {
		const scout: ScoutStatusInput = {
			type: 'web',
			last_run: { started_at: '2026-05-07T08:00:00Z', status: 'failed', articles_count: 0 }
		};
		expect(getScoutStatus(scout)).toEqual({ variant: 'error', key: 'runFailed' });
	});

	// Priority 3: Criteria matched
	it('workspace run with saved articles → new findings (success)', () => {
		const scout: ScoutStatusInput = {
			type: 'web',
			last_run: { started_at: '2026-05-07T08:00:00Z', status: 'completed', articles_count: 2 }
		};
		expect(getScoutStatus(scout)).toEqual({ variant: 'success', key: 'newFindings' });
	});

	it('workspace run with only duplicates → already known (neutral)', () => {
		const scout: ScoutStatusInput = {
			type: 'pulse',
			last_run: {
				started_at: '2026-05-07T08:00:00Z',
				status: 'completed',
				articles_count: 0,
				merged_existing_count: 3
			}
		};
		expect(getScoutStatus(scout)).toEqual({ variant: 'neutral', key: 'alreadyKnown' });
	});

	it('workspace run with no saved articles → no findings saved (neutral)', () => {
		const scout: ScoutStatusInput = {
			type: 'web',
			last_run: { started_at: '2026-05-07T08:00:00Z', status: 'completed', articles_count: 0 }
		};
		expect(getScoutStatus(scout)).toEqual({ variant: 'neutral', key: 'noSavedFindings' });
	});

	it('criteria matched for pulse → new findings (success)', () => {
		const scout: ScoutStatusInput = {
			type: 'pulse',
			last_run: { scraper_status: true, criteria_status: true }
		};
		expect(getScoutStatus(scout)).toEqual({ variant: 'success', key: 'newFindings' });
	});

	it('criteria matched for web → match (success)', () => {
		const scout: ScoutStatusInput = {
			type: 'web',
			last_run: { scraper_status: true, criteria_status: true }
		};
		expect(getScoutStatus(scout)).toEqual({ variant: 'success', key: 'match' });
	});

	// Priority 4: Ran OK, no match
	it('web scout with "No changes" card_summary → no changes (neutral)', () => {
		const scout: ScoutStatusInput = {
			type: 'web',
			last_run: { scraper_status: true, criteria_status: false, card_summary: 'No changes detected' }
		};
		expect(getScoutStatus(scout)).toEqual({ variant: 'neutral', key: 'noChanges' });
	});

	it('web scout with changes but no criteria match → no match (warning)', () => {
		const scout: ScoutStatusInput = {
			type: 'web',
			last_run: { scraper_status: true, criteria_status: false, card_summary: 'Content updated but criteria not met' }
		};
		expect(getScoutStatus(scout)).toEqual({ variant: 'warning', key: 'noMatch' });
	});

	it('pulse no match → no changes (neutral)', () => {
		const scout: ScoutStatusInput = {
			type: 'pulse',
			last_run: { scraper_status: true, criteria_status: false }
		};
		expect(getScoutStatus(scout)).toEqual({ variant: 'neutral', key: 'noChanges' });
	});

});

describe('getScoutStatusLabel', () => {
	it('maps status keys to user-facing labels', () => {
		expect(getScoutStatusLabel('alreadyKnown')).toBe('Already known');
		expect(getScoutStatusLabel({ variant: 'neutral', key: 'noSavedFindings' })).toBe(
			'No findings saved'
		);
	});
});

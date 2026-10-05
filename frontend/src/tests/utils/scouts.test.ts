/**
 * Tests for shared scout utility functions.
 * Pure logic tests — no Svelte rendering needed.
 */
import { describe, it, expect } from 'vitest';
import {
	SCOUT_COSTS,
	getScoutCost,
	normalizeScoutType,
	truncateUrl,
	getScoutStatus,
	type ScoutStatusInput
} from '$lib/utils/scouts';

// ===========================================================================
// SCOUT_COSTS
// ===========================================================================

describe('SCOUT_COSTS', () => {
	it('all scout types have costs', () => {
		expect(Object.keys(SCOUT_COSTS).sort()).toEqual([
			'civic',
			'pulse',
			'social',
			'transport',
			'web'
		]);
	});
});

describe('getScoutCost', () => {
	it('returns base cost for non-social types', () => {
		expect(getScoutCost('web')).toBe(1);
		expect(getScoutCost('pulse')).toBe(7);
		expect(getScoutCost('transport')).toBe(1);
		expect(getScoutCost('civic')).toBe(10);
	});

	it('accepts legacy beat aliases from live data', () => {
		expect(normalizeScoutType('beat')).toBe('pulse');
		expect(getScoutCost('beat')).toBe(7);
	});

	it('returns platform-specific cost for social scouts', () => {
		expect(getScoutCost('social', 'instagram')).toBe(2);
		expect(getScoutCost('social', 'x')).toBe(2);
		expect(getScoutCost('social', 'facebook')).toBe(15);
		expect(getScoutCost('social', 'tiktok')).toBe(2);
		expect(getScoutCost('social', 'linkedin')).toBe(7);
	});

	it('falls back to base social cost for unknown platform', () => {
		expect(getScoutCost('social', 'myspace')).toBe(2);
	});

	it('returns base social cost when no platform given', () => {
		expect(getScoutCost('social')).toBe(2);
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


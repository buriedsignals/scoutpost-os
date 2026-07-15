/**
 * Tests for Transport Scout UI helpers + the skipped status variant.
 */
import { describe, it, expect } from 'vitest';
import {
	transportModeCategories,
	transportRegularities
} from '$lib/utils/transport';
import { getScoutStatus } from '$lib/utils/scouts';

describe('transportModeCategories', () => {
	it('gives aircraft the watchlist categories', () => {
		expect(transportModeCategories('aircraft')).toEqual([
			'military',
			'government',
			'police',
			'civil'
		]);
	});
	it('gives vessels AIS-type categories', () => {
		expect(transportModeCategories('vessel')).toContain('tanker');
	});
	it('offers only real classifier outputs — pleasure, never yacht', () => {
		// 'yacht' was never emitted by _shared/vessel_classify.ts; a scout
		// filtered on it would silently match nothing.
		expect(transportModeCategories('vessel')).toContain('pleasure');
		expect(transportModeCategories('vessel')).not.toContain('yacht');
	});
	it('gives satellites no category filters in v1', () => {
		expect(transportModeCategories('satellite')).toEqual([]);
	});
});

describe('transportRegularities', () => {
	it('offers 3h/6h/12h/daily for aircraft and vessels', () => {
		const a = transportRegularities('aircraft').map((r) => r.value);
		expect(a).toEqual(['3h', '6h', '12h', 'daily']);
	});
	it('pins satellites to daily only', () => {
		const s = transportRegularities('satellite').map((r) => r.value);
		expect(s).toEqual(['daily']);
	});
});

describe('skipped status variant', () => {
	it('classifies a skipped run as neutral, not error', () => {
		const status = getScoutStatus({
			type: 'transport',
			last_run: { started_at: '2026-07-03T12:00:00Z', status: 'skipped', scraper_status: false }
		});
		expect(status.key).toBe('skipped');
		expect(status.variant).toBe('neutral');
	});
	it('still classifies a genuine error run as error', () => {
		const status = getScoutStatus({
			type: 'transport',
			last_run: { started_at: '2026-07-03T12:00:00Z', status: 'error' }
		});
		expect(status.key).toBe('runFailed');
		expect(status.variant).toBe('error');
	});
});

import { transportWatchIdValid, transportParseNum } from '$lib/utils/transport';

describe('transportParseNum (locale-tolerant)', () => {
	it('accepts both dot and comma decimals', () => {
		expect(transportParseNum('12.5')).toBe(12.5);
		expect(transportParseNum('12,5')).toBe(12.5);
	});
	it('returns NaN for junk', () => {
		expect(Number.isNaN(transportParseNum('-'))).toBe(true);
		expect(Number.isNaN(transportParseNum('abc'))).toBe(true);
	});
});

describe('transportWatchIdValid (per mode)', () => {
	it('validates vessel MMSI (9 digits starting 2-7)', () => {
		expect(transportWatchIdValid('vessel', '636019825')).toBe(true);
		expect(transportWatchIdValid('vessel', '12345')).toBe(false);
		expect(transportWatchIdValid('vessel', '111111111')).toBe(false);
	});
	it('validates aircraft ICAO hex', () => {
		expect(transportWatchIdValid('aircraft', '4ca123')).toBe(true);
		expect(transportWatchIdValid('aircraft', 'zzzz')).toBe(false);
	});
	it('validates satellite NORAD', () => {
		expect(transportWatchIdValid('satellite', '25544')).toBe(true);
		expect(transportWatchIdValid('satellite', '0')).toBe(false);
	});
});

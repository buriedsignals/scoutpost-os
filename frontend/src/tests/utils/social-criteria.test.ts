import { describe, expect, it } from 'vitest';
import { describesPostEvents } from '$lib/utils/social-criteria';

describe('describesPostEvents', () => {
	it.each([
		'Notify when post is added\nNotify when post is removed',
		'Alert me on any new post',
		'posts deleted',
		'Tell me whenever they post'
	])('flags criteria that describe posting events: %s', (criteria) => {
		expect(describesPostEvents(criteria)).toBe(true);
	});

	it.each([
		'mentions of housing policy, budget cuts',
		'Notify when the mayor mentions the stadium deal',
		'posts about water contamination in Skopje',
		''
	])('leaves topical criteria alone: %s', (criteria) => {
		expect(describesPostEvents(criteria)).toBe(false);
	});
});

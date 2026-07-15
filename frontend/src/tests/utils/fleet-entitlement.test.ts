import { describe, expect, it } from 'vitest';
import { isFleetScoutLocked } from '$lib/utils/fleet-entitlement';

describe('isFleetScoutLocked', () => {
	it('locks resolved hosted Free accounts', () => {
		expect(isFleetScoutLocked({ isHosted: true, authenticated: true, tier: 'free' })).toBe(true);
	});

	it('allows hosted Pro and Team accounts', () => {
		expect(isFleetScoutLocked({ isHosted: true, authenticated: true, tier: 'pro' })).toBe(false);
		expect(isFleetScoutLocked({ isHosted: true, authenticated: true, tier: 'team' })).toBe(false);
	});

	it('does not show an unresolved auth state as a Free lock', () => {
		expect(isFleetScoutLocked({ isHosted: true, authenticated: false, tier: undefined })).toBe(false);
	});

	it('keeps Fleet available in self-hosted deployments', () => {
		expect(isFleetScoutLocked({ isHosted: false, authenticated: true, tier: 'free' })).toBe(false);
	});
});

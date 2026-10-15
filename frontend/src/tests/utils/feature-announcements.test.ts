import { beforeEach, describe, expect, it } from 'vitest';
import { claimAnnouncement } from '$lib/utils/feature-announcements';

describe('claimAnnouncement', () => {
	beforeEach(() => localStorage.clear());

	it('shows an announcement once per user, and a new id announces again', () => {
		expect(claimAnnouncement('chrome-extension', 'user-a')).toBe(true);
		expect(claimAnnouncement('chrome-extension', 'user-a')).toBe(false);

		// Another account in the same browser still gets it once.
		expect(claimAnnouncement('chrome-extension', 'user-b')).toBe(true);
		// A later feature release uses a new id.
		expect(claimAnnouncement('next-feature', 'user-a')).toBe(true);
	});

	it('does not show when storage is unavailable, so it cannot repeat every visit', () => {
		const original = Storage.prototype.getItem;
		Storage.prototype.getItem = () => {
			throw new DOMException('blocked', 'SecurityError');
		};
		try {
			expect(claimAnnouncement('chrome-extension', 'user-a')).toBe(false);
		} finally {
			Storage.prototype.getItem = original;
		}
	});
});

/**
 * Feature announcements -- one-time "what's new" banners.
 *
 * USED BY: components/ui/FeatureAnnouncement.svelte
 * DEPENDS ON: (none)
 *
 * An announcement is shown the first time a given user opens the workspace in
 * this browser, then never again. To announce a new feature, render
 * FeatureAnnouncement with a new, never-reused `id`; earlier ids stay seen.
 */

const SEEN_KEY_PREFIX = 'scoutpost_announcement_seen:';

function seenKey(announcementId: string, userId: string): string {
	return `${SEEN_KEY_PREFIX}${announcementId}:${userId}`;
}

/**
 * Return true if this user has not seen the announcement yet, and record it as
 * seen so later calls (and later sessions) return false.
 *
 * When storage is unavailable the announcement is not shown: without a record
 * it would reappear on every visit, which is worse than not showing it.
 */
export function claimAnnouncement(announcementId: string, userId: string): boolean {
	if (typeof window === 'undefined') return false;
	try {
		const key = seenKey(announcementId, userId);
		if (localStorage.getItem(key) !== null) return false;
		localStorage.setItem(key, new Date().toISOString());
		return true;
	} catch {
		// Private browsing or blocked site data.
		return false;
	}
}

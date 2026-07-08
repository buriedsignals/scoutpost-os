import { render, fireEvent, screen, waitFor, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ScoutScheduleModal from '$lib/components/modals/ScoutScheduleModal.svelte';
import { apiClient } from '$lib/api-client';

// Mutable auth store so each test can pick a tier (ce-agent-native parity:
// the archive toggle is Pro/Team-gated on SaaS, unlimited on self-host).
type AuthVal = {
	authenticated: boolean;
	user: { credits: number; tier: string; timezone: string };
};
const mockAuth = vi.hoisted(() => ({
	store: null as unknown as { set: (v: AuthVal) => void }
}));
vi.mock('$lib/stores/auth', async () => {
	const { writable } = await import('svelte/store');
	const authState = writable({
		authenticated: true,
		user: { credits: 1000, tier: 'pro', timezone: 'UTC' }
	});
	mockAuth.store = authState;
	return {
		authStore: { subscribe: authState.subscribe, refreshUser: vi.fn() },
		currentUser: authState,
		auth: {}
	};
});

vi.mock('$lib/api-client', () => ({
	apiClient: {
		getActiveJobs: vi.fn().mockResolvedValue({ scrapers: [] }),
		scheduleMonitoring: vi.fn().mockResolvedValue({ ok: true }),
		scheduleLocalScout: vi.fn().mockResolvedValue({ ok: true })
	}
}));

function setTier(tier: 'free' | 'pro' | 'team') {
	mockAuth.store.set({
		authenticated: true,
		user: { credits: 1000, tier, timezone: 'UTC' }
	});
}

const webProps = {
	open: true,
	scoutType: 'web' as const,
	scoutName: 'Evidence page',
	url: 'https://example.com/news',
	topic: 'housing',
	onClose: vi.fn(),
	onSuccess: vi.fn()
};

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	vi.unstubAllEnvs();
	setTier('pro');
});

describe('Page Archive toggle (ScoutScheduleModal, web scout)', () => {
	it('Pro user: enabling archiving sends archive_enabled + wayback_enabled to scheduleMonitoring', async () => {
		setTier('pro');
		render(ScoutScheduleModal, { props: webProps });

		const archive = screen.getByRole('checkbox', { name: /capture evidence snapshots/i });
		expect((archive as HTMLInputElement).disabled).toBe(false);
		await fireEvent.click(archive);

		await fireEvent.click(screen.getByRole('button', { name: /schedule scout/i }));

		await waitFor(() => {
			expect(apiClient.scheduleMonitoring).toHaveBeenCalledWith(
				expect.objectContaining({
					url: 'https://example.com/news',
					archive_enabled: true,
					wayback_enabled: true
				})
			);
		});
	});

	it('Pro user: archiving stays off by default (archive_enabled false in payload)', async () => {
		setTier('pro');
		render(ScoutScheduleModal, { props: webProps });

		await fireEvent.click(screen.getByRole('button', { name: /schedule scout/i }));

		await waitFor(() => {
			expect(apiClient.scheduleMonitoring).toHaveBeenCalledWith(
				expect.objectContaining({ archive_enabled: false })
			);
		});
	});

	it('Free SaaS user: archive toggle is locked with a PRO badge and upsell', async () => {
		vi.stubEnv('PUBLIC_MUCKROCK_ENABLED', 'true');
		setTier('free');
		render(ScoutScheduleModal, { props: webProps });

		const archive = screen.getByRole('checkbox', { name: /capture evidence snapshots/i });
		expect((archive as HTMLInputElement).disabled).toBe(true);
		expect(screen.getByText('PRO')).toBeTruthy();
		expect(screen.getByRole('button', { name: /upgrade to pro to archive/i })).toBeTruthy();
	});
});

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StepButtons from '$lib/components/ui/StepButtons.svelte';
import ScoutScheduleModal from '$lib/components/modals/ScoutScheduleModal.svelte';
import PageScoutView from '$lib/components/news/PageScoutView.svelte';
import { apiClient } from '$lib/api-client';

vi.mock('$lib/stores/auth', async () => {
	const { writable } = await import('svelte/store');
	const state = writable({
		authenticated: true,
		user: { credits: 1000, tier: 'pro', timezone: 'UTC' }
	});
	return {
		authStore: { subscribe: state.subscribe, refreshUser: vi.fn() },
		currentUser: state,
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

beforeEach(() => {
	vi.stubEnv('PUBLIC_DEPLOYMENT_TARGET', 'supabase');
	vi.stubEnv('PUBLIC_MUCKROCK_ENABLED', 'false');
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	vi.unstubAllEnvs();
});

describe('shared scout creation hierarchy', () => {
	it('opens Page Scout on Specific Criteria and blocks an empty rule', async () => {
		render(PageScoutView);
		expect(screen.getByText('Specific Criteria')).toBeInTheDocument();
		await fireEvent.input(screen.getByPlaceholderText('e.g. Town Hall Events'), { target: { value: 'Council agenda' } });
		await fireEvent.input(screen.getByPlaceholderText('https://example.com'), { target: { value: 'https://example.com' } });
		expect(screen.getByRole('button', { name: /test scraper/i })).toBeDisabled();
		await fireEvent.input(screen.getByPlaceholderText('Describe what to look for...'), { target: { value: 'new agenda items' } });
		expect(screen.getByRole('button', { name: /test scraper/i })).toBeEnabled();
	});

	it('moves primary emphasis to the next enabled step', async () => {
		const { rerender } = render(StepButtons, {
			props: {
				step1Label: 'Test source',
				step1LoadingLabel: 'Testing',
				step2Label: 'Schedule scout',
				step2Enabled: false
			}
		});

		expect(screen.getByRole('button', { name: /test source/i }).classList.contains('btn-primary')).toBe(true);
		expect(screen.getByRole('button', { name: /schedule scout/i }).classList.contains('btn-secondary')).toBe(true);

		await rerender({
			step1Label: 'Test source',
			step1LoadingLabel: 'Testing',
			step2Label: 'Schedule scout',
			step2Enabled: true
		});

		expect(screen.getByRole('button', { name: /test source/i }).classList.contains('btn-secondary')).toBe(true);
		expect(screen.getByRole('button', { name: /schedule scout/i }).classList.contains('btn-primary')).toBe(true);
	});

	it('collects the Fleet Scout name in Step 2 and submits the tested baseline', async () => {
		render(ScoutScheduleModal, {
			props: {
				open: true,
				scoutType: 'transport',
				transportMode: 'aircraft',
				transportConfig: {
					mode: 'aircraft',
					watch_ids: ['abc123'],
					geofence: { center: { lat: 47, lon: 8 }, radius_km: 100 }
				},
				transportBaselineIds: ['abc123']
			}
		});

		await fireEvent.input(screen.getByLabelText(/scout name/i), { target: { value: 'Airport watch' } });
		await fireEvent.click(screen.getByRole('button', { name: /schedule scout/i }));

		await waitFor(() => {
			expect(apiClient.scheduleLocalScout).toHaveBeenCalledWith(
				expect.objectContaining({
					name: 'Airport watch',
					scout_type: 'transport',
					transport_baseline_ids: ['abc123']
				})
			);
		});
	});
});

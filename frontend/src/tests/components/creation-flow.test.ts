import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StepButtons from '$lib/components/ui/StepButtons.svelte';
import ScoutScheduleModal from '$lib/components/modals/ScoutScheduleModal.svelte';
import PageScoutView from '$lib/components/news/PageScoutView.svelte';
import { apiClient } from '$lib/api-client';
import { webhookClient } from '$lib/services/webhook-client';

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

vi.mock('$lib/services/webhook-client', () => ({
	webhookClient: { testScraper: vi.fn().mockResolvedValue({ scraper_status: true, criteria_status: true, summary: 'Reachable', content_hash: 'baseline' }) }
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
		expect(screen.queryByLabelText(/scout name/i)).not.toBeInTheDocument();
		await fireEvent.input(screen.getByPlaceholderText('https://example.com'), { target: { value: 'https://example.com' } });
		expect(screen.getByRole('button', { name: /test scraper/i })).toBeDisabled();
		await fireEvent.input(screen.getByPlaceholderText('Describe what to look for...'), { target: { value: 'new agenda items' } });
		expect(screen.getByRole('button', { name: /test scraper/i })).toBeEnabled();
	});

	it('warns before enabling whole-page Any Change monitoring', async () => {
		render(PageScoutView);
		expect(screen.queryByRole('note')).not.toBeInTheDocument();

		await fireEvent.click(screen.getByRole('radio', { name: /any change/i }));

		expect(screen.getByRole('note')).toHaveTextContent(
			/alert on cookie notices, forms, navigation and other page chrome/i
		);
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

	it('collects the Page Scout name in the scheduling step', () => {
		render(ScoutScheduleModal, {
			props: {
				open: true,
				scoutType: 'web',
				url: 'https://example.com',
				webCriteria: 'new agenda items'
			}
		});

		expect(screen.getByLabelText(/scout name/i)).toBeInTheDocument();
	});


	it('requires a project without a location and commits a typed project before scheduling', async () => {
		render(ScoutScheduleModal, { props: {
			open: true, scoutType: 'web', url: 'https://example.com', scoutName: 'Council'
		} });
		const project = screen.getByLabelText(/project/i);
		expect(project).toBeRequired();
		await fireEvent.input(project, { target: { value: 'Housing' } });
		await fireEvent.blur(project);
		await fireEvent.click(screen.getByRole('button', { name: /schedule scout/i }));
		await waitFor(() => expect(apiClient.scheduleMonitoring).toHaveBeenCalledWith(
			expect.objectContaining({ topic: 'Housing' })
		));
	});

	it('accepts a project-only Beat scout without adding a separate criteria requirement', async () => {
		render(ScoutScheduleModal, { props: {
			open: true, scoutType: 'pulse', scoutName: 'Housing', topic: 'housing'
		} });
		await fireEvent.click(screen.getByRole('button', { name: /schedule scout/i }));
		await waitFor(() => expect(apiClient.scheduleLocalScout).toHaveBeenCalledWith(
			expect.objectContaining({ topic: 'housing', location: undefined, criteria: undefined })
		));
	});

	it.each(['web', 'social', 'civic'] as const)('keeps project optional and submits the existing location for %s', async (scoutType) => {
		const location = { displayName: 'Zurich, Switzerland', city: 'Zurich', country: 'CH', locationType: 'city' as const };
		render(ScoutScheduleModal, { props: {
			open: true, scoutType, scoutName: 'Local watch', location,
			url: 'https://example.com', profile_handle: 'council', monitor_mode: 'summarize',
			root_domain: 'example.com', tracked_urls: ['https://example.com/meetings'],
			importCurrentItems: false
		} });
		expect(screen.getByLabelText(/project/i)).not.toBeRequired();
		await fireEvent.click(screen.getByRole('button', { name: /schedule scout/i }));
		const schedule = scoutType === 'web' ? apiClient.scheduleMonitoring : apiClient.scheduleLocalScout;
		await waitFor(() => expect(schedule).toHaveBeenCalledWith(
			expect.objectContaining({ location, topic: undefined })
		));
	});

	it('requires a fresh Page probe after a required input changes', async () => {
		render(PageScoutView);
		await fireEvent.input(screen.getByPlaceholderText('https://example.com'), { target: { value: 'https://example.com' } });
		await fireEvent.input(screen.getByPlaceholderText('Describe what to look for...'), { target: { value: 'new agenda items' } });
		await fireEvent.click(screen.getByRole('button', { name: /test scraper/i }));
		await waitFor(() => expect(screen.getByRole('button', { name: /schedule scout/i })).toBeEnabled());
		await fireEvent.input(screen.getByPlaceholderText('Describe what to look for...'), { target: { value: '' } });
		expect(screen.getByRole('button', { name: /schedule scout/i })).toBeDisabled();
		await waitFor(() => expect(screen.queryByText(/^\d+%$/)).not.toBeInTheDocument());
	});

	it.each(['resolve', 'reject'] as const)('discards a pending probe %s after the URL changes', async (outcome) => {
		const pending = Promise.withResolvers<void>();
		vi.mocked(webhookClient.testScraper).mockImplementationOnce(async () => {
			await pending.promise;
			return { scraper_status: true, criteria_status: true, summary: 'Stale page', content_hash: 'stale' };
		});
		render(PageScoutView);
		await fireEvent.input(screen.getByPlaceholderText('https://example.com'), { target: { value: 'https://example.com' } });
		await fireEvent.click(screen.getByRole('radio', { name: /any change/i }));
		await fireEvent.click(screen.getByRole('button', { name: /test scraper/i }));
		await fireEvent.input(screen.getByPlaceholderText('https://example.com'), { target: { value: 'https://example.org' } });
		if (outcome === 'resolve') {
			pending.resolve();
		} else {
			pending.reject(new Error('Stale failure'));
		}
		await waitFor(() => expect(screen.getByRole('button', { name: /test scraper/i })).toBeEnabled());
		expect(screen.getByRole('button', { name: /schedule scout/i })).toBeDisabled();
		expect(screen.queryByText(/^\d+%$/)).not.toBeInTheDocument();
		expect(screen.queryByText(/Stale page|Stale failure/)).not.toBeInTheDocument();
	});

	it('shows a fresh form when scheduling another Page after success', async () => {
		render(PageScoutView);
		await fireEvent.input(screen.getByPlaceholderText('https://example.com'), { target: { value: 'https://example.com' } });
		await fireEvent.click(screen.getByRole('radio', { name: /any change/i }));
		await fireEvent.click(screen.getByRole('button', { name: /test scraper/i }));
		await waitFor(() => expect(screen.getByRole('button', { name: /schedule scout/i })).toBeEnabled());
		await fireEvent.click(screen.getByRole('button', { name: /schedule scout/i }));
		await fireEvent.input(screen.getByLabelText(/scout name/i), { target: { value: 'First scout' } });
		const project = screen.getByLabelText(/project/i);
		await fireEvent.input(project, { target: { value: 'Housing' } });
		await fireEvent.blur(project);
		await fireEvent.submit(screen.getByRole('form'));
		await waitFor(() => expect(screen.queryByRole('form')).not.toBeInTheDocument());
		await fireEvent.input(screen.getByPlaceholderText('https://example.com'), { target: { value: 'https://example.org' } });
		await fireEvent.click(screen.getByRole('radio', { name: /any change/i }));
		await fireEvent.click(screen.getByRole('button', { name: /test scraper/i }));
		await waitFor(() => expect(screen.getByRole('button', { name: /schedule scout/i })).toBeEnabled());
		await fireEvent.click(screen.getByRole('button', { name: /schedule scout/i }));
		expect(screen.getByLabelText(/scout name/i)).toHaveValue('');
		expect(screen.getByLabelText(/project/i)).toHaveValue('');
		expect(screen.queryByText('First scout')).not.toBeInTheDocument();
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

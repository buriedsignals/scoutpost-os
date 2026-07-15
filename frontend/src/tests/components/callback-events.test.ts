import { render, fireEvent, screen, waitFor, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import NewScoutDropdown from '$lib/components/workspace/NewScoutDropdown.svelte';
import ScoutCard from '$lib/components/workspace/ScoutCard.svelte';
import UnitRow from '$lib/components/workspace/UnitRow.svelte';
import ScoutScheduleModal from '$lib/components/modals/ScoutScheduleModal.svelte';
import { apiClient } from '$lib/api-client';
import type { Scout, Unit } from '$lib/types/workspace';

vi.mock('$lib/stores/auth', async () => {
	const { writable } = await import('svelte/store');
	const authState = writable({
		authenticated: true,
		user: {
			credits: 1000,
			tier: 'pro',
			timezone: 'UTC'
		}
	});

	return {
		authStore: {
			subscribe: authState.subscribe,
			refreshUser: vi.fn()
		},
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

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

function makeScout(): Scout {
	return {
		id: 'scout-1',
		name: 'City Hall Watch',
		type: 'web',
		topic: 'housing',
		url: 'https://example.com/news',
		is_active: true,
		regularity: 'daily',
		last_run: {
			started_at: '2026-04-27T10:00:00.000Z',
			status: 'success',
			articles_count: 2
		}
	};
}

function makeUnit(): Unit {
	return {
		id: 'unit-1',
		statement: 'Council approved the housing motion.',
		context_excerpt: 'The council voted in favor of the motion.',
		unit_type: 'decision',
		entities: [],
		extracted_at: '2026-04-27T10:00:00.000Z',
		source: {
			url: 'https://example.com/story',
			title: 'Council story',
			domain: 'example.com'
		},
		verification: {
			verified: false,
			verified_at: null,
			verified_by: null,
			notes: null
		},
		scout_name: 'City Hall Watch'
	};
}

describe('callback props for workspace components', () => {
	it('calls the NewScoutDropdown selection callback for each scout type', async () => {
		const options: Array<[RegExp, string]> = [
			[/track a page/i, 'web'],
			[/track a beat/i, 'pulse'],
			[/track a profile/i, 'social'],
			[/track a council/i, 'civic'],
			[/track a fleet/i, 'transport']
		];

		for (const [label, expectedType] of options) {
			const onSelect = vi.fn();

			render(NewScoutDropdown, {
				props: {
					onSelect
				}
			});

			await fireEvent.click(screen.getByRole('button', { name: /new scout/i }));
			await fireEvent.click(screen.getByRole('menuitem', { name: label }));

			expect(onSelect).toHaveBeenCalledWith(expectedType);
			cleanup();
		}
	});

	it('calls ScoutCard action callbacks without opening the card', async () => {
		const scout = makeScout();
		const onOpen = vi.fn();
		const onRun = vi.fn();
		const onRequestDelete = vi.fn();

		render(ScoutCard, {
			props: {
				scout,
				onOpen,
				onRun,
				onRequestDelete
			}
		});

		await fireEvent.click(screen.getByText('City Hall Watch'));
		expect(onOpen).toHaveBeenCalledWith(scout);

		onOpen.mockClear();
		await fireEvent.click(screen.getByRole('button', { name: /run now/i }));
		expect(onRun).toHaveBeenCalledWith('scout-1');
		expect(onOpen).not.toHaveBeenCalled();

		await fireEvent.click(screen.getByRole('button', { name: /delete scout/i }));
		expect(onRequestDelete).toHaveBeenCalledWith('scout-1');
		expect(onOpen).not.toHaveBeenCalled();
	});

	it('calls UnitRow action callbacks without opening the row', async () => {
		const unit = makeUnit();
		const onOpen = vi.fn();
		const onVerify = vi.fn();
		const onRequestDelete = vi.fn();

		render(UnitRow, {
			props: {
				unit,
				onOpen,
				onVerify,
				onRequestDelete
			}
		});

		await fireEvent.click(screen.getByText('Council approved the housing motion.'));
		expect(onOpen).toHaveBeenCalledWith(unit);

		onOpen.mockClear();
		await fireEvent.click(screen.getByRole('button', { name: /mark verified/i }));
		expect(onVerify).toHaveBeenCalledWith('unit-1');
		expect(onOpen).not.toHaveBeenCalled();

		await fireEvent.click(screen.getByRole('button', { name: /delete unit/i }));
		expect(onRequestDelete).toHaveBeenCalledWith('unit-1');
		expect(onOpen).not.toHaveBeenCalled();
	});
});

describe('callback props for scout scheduling', () => {
	it('calls ScoutScheduleModal close and success callbacks', async () => {
		const onClose = vi.fn();
		const onSuccess = vi.fn();

		render(ScoutScheduleModal, {
			props: {
				open: true,
				scoutType: 'web',
				scoutName: 'Example page scout',
				url: 'https://example.com/news',
				topic: 'housing',
				onClose,
				onSuccess
			}
		});

		await fireEvent.click(screen.getByRole('button', { name: /close modal/i }));
		expect(onClose).toHaveBeenCalledTimes(1);

		cleanup();

		render(ScoutScheduleModal, {
			props: {
				open: true,
				scoutType: 'web',
				scoutName: 'Example page scout',
				url: 'https://example.com/news',
				topic: 'housing',
				onClose,
				onSuccess
			}
		});

		await fireEvent.click(screen.getByRole('button', { name: /schedule scout/i }));

		await waitFor(() => {
			expect(apiClient.scheduleMonitoring).toHaveBeenCalledWith(
				expect.objectContaining({
					name: 'Example page scout',
					url: 'https://example.com/news',
					topic: 'housing'
				})
			);
			expect(onSuccess).toHaveBeenCalledWith({
				name: 'Example page scout',
				scoutType: 'web'
			});
		});
	});
});

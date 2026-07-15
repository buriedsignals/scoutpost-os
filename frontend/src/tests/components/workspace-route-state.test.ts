import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WorkspacePage from '../../routes/+page.svelte';
import { scoutsStore } from '$lib/stores/workspace/scouts';
import { unitsStore } from '$lib/stores/workspace/units';
import { selectionStore } from '$lib/stores/workspace/selection';

vi.mock('$lib/demo/state', () => ({
	IS_LOCAL_DEMO_MODE: true
}));

vi.mock('$lib/stores/auth', async () => {
	const { writable } = await import('svelte/store');
	const state = writable({
		authenticated: true,
		loading: false,
		user: {
			email: 'editor@example.com',
			credits: 1000,
			tier: 'pro',
			timezone: 'UTC'
		}
	});

	return {
		authStore: {
			subscribe: state.subscribe,
			refreshUser: vi.fn(),
			signOut: vi.fn()
		},
		currentUser: state,
		auth: {}
	};
});

beforeEach(() => {
	localStorage.clear();
	scoutsStore.reset();
	unitsStore.reset();
	selectionStore.clear();
});

afterEach(() => {
	cleanup();
	scoutsStore.reset();
	unitsStore.reset();
	selectionStore.clear();
	vi.clearAllMocks();
});

describe('workspace route state and navigation contract', () => {
	it('preserves State 1 and State 2 inbox scope with only location and topic filters', async () => {
		render(WorkspacePage);

		await screen.findByText('Scouts · 4');
		expect(screen.getAllByRole('combobox')).toHaveLength(2);
		expect(screen.queryByText('All scouts')).not.toBeInTheDocument();
		expect(unitsStore.getState().scoutId).toBeNull();

		const allScopeInbox = screen.getByRole('region', { name: /information unit inbox/i });
		expect(within(allScopeInbox).getByRole('button', { name: /^needs review ·/i })).toBeInTheDocument();
		await fireEvent.click(within(allScopeInbox).getByRole('button', { name: /^all ·/i }));
		expect(screen.getByPlaceholderText('Search all inbox units')).toBeInTheDocument();

		await fireEvent.click(screen.getByRole('heading', { level: 3, name: 'Oakland City Hall · climate & transit' }));
		await waitFor(() => {
			expect(selectionStore.getState().scoutId).toBe('demo-web');
			expect(unitsStore.getState().scoutId).toBe('demo-web');
		});

		expect(screen.getByRole('button', { name: /all scouts/i })).toBeInTheDocument();
		expect(screen.getByPlaceholderText('Search this inbox')).toBeInTheDocument();
		const focusedInbox = screen.getByRole('region', { name: /information unit inbox/i });
		await fireEvent.click(within(focusedInbox).getByRole('button', { name: /^needs review ·/i }));
		expect(within(focusedInbox).getByRole('button', { name: /^all ·/i })).toBeInTheDocument();

		await fireEvent.click(screen.getByRole('button', { name: /all scouts/i }));
		await waitFor(() => {
			expect(selectionStore.getState().scoutId).toBeNull();
			expect(unitsStore.getState().scoutId).toBeNull();
		});

		expect(screen.getByText('Scouts · 4')).toBeInTheDocument();
		expect(screen.getByPlaceholderText('Search all inbox units')).toBeInTheDocument();
	});

	it('keeps Connect Agent prominent while the user-menu API entry remains API-only', async () => {
		const user = userEvent.setup();
		render(WorkspacePage);
		await screen.findByText('Scouts · 4');

		const actions = screen.getByLabelText('Workspace actions');
		const newScoutButton = within(actions).getByRole('button', { name: /new scout/i });
		const connectAgentButton = within(actions).getByRole('button', { name: /connect agent/i });
		expect(newScoutButton).toHaveClass('cursor-pointer');
		expect(connectAgentButton).toHaveClass('cursor-pointer');

		await user.click(newScoutButton);
		await waitFor(() => {
			expect(newScoutButton).toHaveAttribute('aria-expanded', 'true');
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(newScoutButton).toHaveAttribute('aria-expanded', 'true');
		await fireEvent.keyDown(document, { key: 'Escape' });
		await waitFor(() => {
			expect(newScoutButton).toHaveAttribute('aria-expanded', 'false');
		});

		await fireEvent.click(connectAgentButton);
		expect(screen.getByRole('dialog', { name: /connect an agent/i })).toBeInTheDocument();
		expect(screen.getByText('Connect an agent')).toBeInTheDocument();

		await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		await fireEvent.click(screen.getByRole('button', { name: /user menu/i }));
		await fireEvent.click(screen.getByRole('menuitem', { name: 'API' }));

		expect(screen.getByRole('dialog', { name: /connect an agent/i })).toBeInTheDocument();
		expect(screen.getByText('REST API')).toBeInTheDocument();
	});
});

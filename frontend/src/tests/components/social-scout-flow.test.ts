import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SocialScoutView from '$lib/components/news/SocialScoutView.svelte';

vi.mock('$lib/stores/auth', async () => {
	const { writable } = await import('svelte/store');
	const state = writable({
		authenticated: true,
		user: { credits: 1000, tier: 'pro', timezone: 'UTC' }
	});
	return {
		authStore: {
			subscribe: state.subscribe,
			getToken: vi.fn().mockResolvedValue('test-token'),
			refreshUser: vi.fn()
		},
		currentUser: state,
		auth: {}
	};
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe('Social Scout criteria and LinkedIn flow', () => {
	it('uses a LinkedIn URL and discards a scan response after the URL changes', async () => {
		let resolveFetch!: (value: unknown) => void;
		vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => (resolveFetch = resolve))));

		render(SocialScoutView);
		await fireEvent.change(screen.getByLabelText('Platform'), { target: { value: 'linkedin' } });

		const profileInput = screen.getByLabelText('LinkedIn profile URL');
		expect(profileInput).toHaveAttribute('placeholder', 'https://www.linkedin.com/in/username');
		await fireEvent.input(profileInput, { target: { value: 'https://www.linkedin.com/in/first-person' } });
		await fireEvent.input(screen.getByLabelText('Alert Criteria'), { target: { value: 'housing policy' } });
		await fireEvent.click(screen.getByRole('button', { name: /scan profile/i }));

		await fireEvent.input(profileInput, { target: { value: 'https://www.linkedin.com/in/second-person' } });
		resolveFetch({
			ok: true,
			json: async () => ({
				valid: true,
				profile_url: 'https://www.linkedin.com/in/first-person',
				profile_handle: 'first-person',
				post_ids: ['post-1'],
				preview_posts: [],
				posts_data: []
			})
		});

		await waitFor(() => {
			expect(screen.getByRole('button', { name: /schedule scout/i })).toBeDisabled();
		});
	});
});

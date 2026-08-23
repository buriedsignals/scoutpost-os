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

const PRIVATE_PROFILE_COPY =
	'Private Instagram profiles cannot be monitored. Choose a public profile.';
const UNKNOWN_PROFILE_COPY =
	'Instagram privacy could not be confirmed. Continue only if this is a public profile.';

async function submitInstagramScan() {
	render(SocialScoutView);
	await fireEvent.input(screen.getByLabelText('Handle'), {
		target: { value: 'example-profile' }
	});
	await fireEvent.input(screen.getByLabelText('Alert Criteria'), {
		target: { value: 'housing policy' }
	});
	await fireEvent.click(screen.getByRole('button', { name: /scan profile/i }));
}

describe('Social Scout Instagram privacy setup', () => {
	it('shows the confirmed-private stop and never enables scheduling', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({
					valid: false,
					profile_url: 'https://www.instagram.com/example-profile/',
					profile_handle: 'example-profile',
					profile_visibility: 'private',
					error: PRIVATE_PROFILE_COPY,
					post_ids: [],
					preview_posts: [],
					posts_data: []
				})
			})
		);

		await submitInstagramScan();

		await waitFor(() => {
			expect(screen.getByText(PRIVATE_PROFILE_COPY)).toBeInTheDocument();
		});
		expect(screen.queryByRole('button', { name: /schedule scout/i })).not.toBeInTheDocument();
	});

	it('shows the unknown warning and can schedule without a durable context token', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({
					valid: true,
					profile_url: 'https://www.instagram.com/example-profile/',
					profile_handle: 'example-profile',
					profile_visibility: 'unknown',
					warning: UNKNOWN_PROFILE_COPY,
					post_ids: ['POST-1'],
					preview_posts: [],
					posts_data: [{ id: 'POST-1' }]
				})
			})
		);

		await submitInstagramScan();

		await waitFor(() => {
			expect(screen.getByText(UNKNOWN_PROFILE_COPY)).toBeInTheDocument();
		});
		expect(screen.getByRole('button', { name: /schedule scout/i })).toBeEnabled();
	});
});

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PreferencesModal from '$lib/components/modals/PreferencesModal.svelte';

// The real api-client runs against a stubbed fetch: only the HTTP response and
// the browser's object-URL download are faked.

vi.mock('$lib/stores/auth', async () => {
	const { readable } = await import('svelte/store');
	const state = readable({
		authenticated: true,
		user: {
			user_id: '00000000-0000-4000-8000-000000000001',
			credits: 0,
			timezone: 'UTC',
			default_location: null,
			needs_initialization: false,
			onboarding_completed: true,
			preferred_language: 'en',
			tier: 'free',
			excluded_domains: []
		}
	});
	return {
		authStore: {
			subscribe: state.subscribe,
			getToken: vi.fn().mockResolvedValue('session-token'),
			updatePreferences: vi.fn()
		},
		currentUser: state,
		auth: {}
	};
});

const fetchMock = vi.fn<typeof fetch>();
const downloads: string[] = [];

beforeEach(() => {
	vi.stubGlobal('fetch', fetchMock);
	URL.createObjectURL = vi.fn(() => 'blob:export');
	URL.revokeObjectURL = vi.fn();
	vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
		downloads.push(this.download);
	});
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	fetchMock.mockReset();
	downloads.length = 0;
});

async function startExport() {
	render(PreferencesModal, { props: { open: true } });
	await fireEvent.click(screen.getByRole('button', { name: 'Download my data' }));
}

describe('Preferences data export', () => {
	it('downloads the session export under the server filename', async () => {
		fetchMock.mockResolvedValue(
			new Response('{"sections":{}}', {
				headers: {
					'Content-Type': 'application/json',
					'Content-Disposition': 'attachment; filename="scoutpost-data-2026-01-02.json"'
				}
			})
		);

		await startExport();

		await waitFor(() => expect(downloads).toEqual(['scoutpost-data-2026-01-02.json']));
		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toMatch(/\/user\/data-export$/);
		expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer session-token');
		expect(screen.getByRole('button', { name: 'Download my data' })).toBeEnabled();
		expect(screen.queryByRole('alert')).toBeNull();
	});

	it('explains the hourly limit with the server retry time', async () => {
		fetchMock.mockResolvedValue(
			Response.json(
				{ error: 'Data export limit reached', code: 'rate_limit', retry_after_seconds: 1500 },
				{ status: 429 }
			)
		);

		await startExport();

		expect(await screen.findByRole('alert')).toHaveTextContent(
			"You've reached the hourly export limit. Try again in 25 min."
		);
		expect(downloads).toEqual([]);
	});

	it('saves nothing when the export stream fails part-way', async () => {
		fetchMock.mockResolvedValue(
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('{"sections":{"scouts":{"rows":['));
						controller.error(new Error('database read failed'));
					}
				}),
				{ headers: { 'Content-Type': 'application/json' } }
			)
		);

		await startExport();

		expect(await screen.findByRole('alert')).toHaveTextContent(
			"We couldn't prepare your data export. Try again in a moment."
		);
		expect(downloads).toEqual([]);
	});
});

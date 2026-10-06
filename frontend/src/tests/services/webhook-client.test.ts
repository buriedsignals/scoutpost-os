/**
 * Tests for webhook-client — verifies Bearer auth, request body, response mapping and error handling.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/config/api', () => ({
	buildApiUrl: (path: string) => `/api${path.startsWith('/') ? path : '/' + path}`
}));

const auth = vi.hoisted(() => ({ getToken: vi.fn<() => Promise<string | null>>() }));
vi.mock('$lib/stores/auth', () => ({ authStore: auth }));

import { webhookClient } from '$lib/services/webhook-client';

function mockFetchResponse(body: unknown, status = 200) {
	return vi.fn().mockResolvedValue({
		ok: status >= 200 && status < 300,
		status,
		statusText: status === 200 ? 'OK' : 'Error',
		json: vi.fn().mockResolvedValue(body)
	});
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
	vi.clearAllMocks();
	auth.getToken.mockResolvedValue(null);
	fetchSpy = mockFetchResponse({});
	vi.stubGlobal('fetch', fetchSpy);
});

describe('webhookClient.testScraper', () => {
	it.each([
		['a session token', 'session-jwt', 'Bearer session-jwt'],
		['no session token', null, undefined]
	])('posts to /scouts/test with %s as Bearer auth and no cookies', async (_label, token, expected) => {
		auth.getToken.mockResolvedValue(token);

		await webhookClient.testScraper({ url: 'https://example.com' });

		const [url, options] = fetchSpy.mock.calls[0];
		expect(url).toBe('/api/scouts/test');
		expect(options.method).toBe('POST');
		// credentials dropped — Supabase Edge Functions return '*' origin;
		// browsers reject credentials:'include' with wildcard CORS.
		expect(options.credentials).toBeUndefined();
		expect(options.headers.Authorization).toBe(expected);
	});

	it('sends exactly url, criteria, and scraperName in body (no userId)', async () => {
		fetchSpy = mockFetchResponse({
			summary: 'found',
			scraper_status: true,
			criteria_status: true
		});
		vi.stubGlobal('fetch', fetchSpy);

		await webhookClient.testScraper({
			url: 'https://example.com',
			criteria: 'price changes',
			scraperName: 'my-scout'
		});

		const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
		expect(body).toEqual({
			url: 'https://example.com',
			criteria: 'price changes',
			scraperName: 'my-scout'
		});
	});

	it('throws on non-ok response', async () => {
		fetchSpy = mockFetchResponse({}, 401);
		vi.stubGlobal('fetch', fetchSpy);

		await expect(
			webhookClient.testScraper({ url: 'https://example.com' })
		).rejects.toThrow('Scout test failed: 401');
	});

	it('returns parsed response fields', async () => {
		fetchSpy = mockFetchResponse({
			summary: 'Page content changed',
			scraper_status: true,
			criteria_status: true,
			content_hash: 'abc123'
		});
		vi.stubGlobal('fetch', fetchSpy);

		const result = await webhookClient.testScraper({ url: 'https://example.com' });

		expect(result).toEqual({
			summary: 'Page content changed',
			scraper_status: true,
			criteria_status: true,
			content_hash: 'abc123'
		});
	});

	it('passes the probe envelope through and fills missing legacy fields', async () => {
		fetchSpy = mockFetchResponse({
			ok: false,
			stage: 'reach',
			error_code: 'blocked',
			error: 'The site blocked automated access.'
		});
		vi.stubGlobal('fetch', fetchSpy);

		const result = await webhookClient.testScraper({ url: 'https://example.com' });

		expect(result).toEqual({
			summary: '',
			scraper_status: true,
			criteria_status: false,
			content_hash: undefined,
			ok: false,
			stage: 'reach',
			error_code: 'blocked',
			error: 'The site blocked automated access.'
		});
	});
});

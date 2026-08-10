/**
 * Tests for webhook-client — verifies cookie-based auth, request body, and error handling.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/config/api', () => ({
	buildApiUrl: (path: string) => `/api${path.startsWith('/') ? path : '/' + path}`
}));

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
	fetchSpy = mockFetchResponse({});
	vi.stubGlobal('fetch', fetchSpy);
});

describe('webhookClient.testScraper', () => {
	it('uses Bearer auth (no credentials; Authorization carries JWT when present)', async () => {
		fetchSpy = mockFetchResponse({
			summary: 'ok',
			scraper_status: true,
			criteria_status: false
		});
		vi.stubGlobal('fetch', fetchSpy);

		await webhookClient.testScraper({ url: 'https://example.com' });

		const options = fetchSpy.mock.calls[0][1];
		// credentials dropped — Supabase Edge Functions return '*' origin;
		// browsers reject credentials:'include' with wildcard CORS.
		expect(options.credentials).toBeUndefined();
		const auth = options.headers?.Authorization;
		expect(auth === undefined || /^Bearer /.test(auth)).toBe(true);
	});

	it('sends url, criteria, and scraperName in body', async () => {
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
		expect(body.url).toBe('https://example.com');
		expect(body.criteria).toBe('price changes');
		expect(body.scraperName).toBe('my-scout');
	});

	it('does not send userId in body', async () => {
		fetchSpy = mockFetchResponse({
			summary: '',
			scraper_status: true,
			criteria_status: false
		});
		vi.stubGlobal('fetch', fetchSpy);

		await webhookClient.testScraper({ url: 'https://example.com' });

		const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
		expect(body.userId).toBeUndefined();
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

		expect(result.summary).toBe('Page content changed');
		expect(result.scraper_status).toBe(true);
		expect(result.criteria_status).toBe(true);
		expect(result.content_hash).toBe('abc123');
	});
});

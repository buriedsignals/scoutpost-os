/**
 * Tests for the API client — verifies request URLs, methods, bodies, and error handling.
 * Mocks fetch to test the frontend->backend contract.
 * Auth is Bearer JWT via authStore.getToken() — no cookies.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/config/api', () => ({
	API_BASE_URL: '/api',
	buildApiUrl: (path: string) => `/api${path.startsWith('/') ? path : '/' + path}`,
	buildFastApiUrl: (path: string) => `/api${path.startsWith('/') ? path : '/' + path}`
}));

import { apiClient, apiRequest, submitFeedback } from '$lib/api-client';

// ---- Test helpers ----

function mockFetchResponse(body: unknown, status = 200) {
	return vi.fn().mockResolvedValue({
		ok: status >= 200 && status < 300,
		status,
		json: vi.fn().mockResolvedValue(body),
		text: vi.fn().mockResolvedValue(JSON.stringify(body))
	});
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
	vi.clearAllMocks();
	fetchSpy = mockFetchResponse({});
	vi.stubGlobal('fetch', fetchSpy);
});

// ===========================================================================
// getActiveJobs
// ===========================================================================

describe('getActiveJobs', () => {
	it('calls GET /scouts EF with Bearer auth (post-cutover adapter)', async () => {
		fetchSpy = mockFetchResponse({ items: [], pagination: { total: 0 } });
		vi.stubGlobal('fetch', fetchSpy);

		await apiClient.getActiveJobs();

		expect(fetchSpy).toHaveBeenCalledWith(
			'/api/scouts?limit=100&offset=0',
			expect.objectContaining({
				method: 'GET',
				headers: expect.objectContaining({ 'Content-Type': 'application/json' })
			})
		);
		const options = fetchSpy.mock.calls[0][1];
		expect(options.credentials).toBeUndefined();
	});

	it('reshapes EF {items} → legacy {scrapers: [{scraper_name}]}', async () => {
		fetchSpy = mockFetchResponse({
			items: [{ id: 'uuid-1', name: 'test', user_id: 'u1' }],
			pagination: { total: 1 }
		});
		vi.stubGlobal('fetch', fetchSpy);

		const result = await apiClient.getActiveJobs();
		// Adapter surfaces `scraper_name` mirroring `name` so legacy UI works.
		expect(result.scrapers[0].scraper_name).toBe('test');
		expect(result.user).toBe('u1');
	});

	it('throws on API error', async () => {
		fetchSpy = mockFetchResponse({ detail: 'Server error' }, 500);
		vi.stubGlobal('fetch', fetchSpy);

		// Adapter discards body and reports status — see normalizeErrorDetail call.
		await expect(apiClient.getActiveJobs()).rejects.toThrow('API error: 500');
	});
});

// ===========================================================================
// searchPulse
// ===========================================================================

describe('searchPulse', () => {
	it('requires location or criteria', async () => {
		await expect(apiClient.searchPulse({})).rejects.toThrow(
			'Location or criteria is required'
		);
	});

	it('sends criteria-only search', async () => {
		const mockResult = { status: 'completed', articles: [] };
		fetchSpy = mockFetchResponse(mockResult);
		vi.stubGlobal('fetch', fetchSpy);

		await apiClient.searchPulse({ criteria: 'AI' });

		const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
		expect(body.criteria).toBe('AI');
		expect(body.category).toBe('news');
	});

	it('passes custom filter prompt', async () => {
		fetchSpy = mockFetchResponse({ status: 'completed', articles: [] });
		vi.stubGlobal('fetch', fetchSpy);

		await apiClient.searchPulse({
			criteria: 'tech',
			custom_filter_prompt: 'Focus on startups'
		});

		const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
		expect(body.custom_filter_prompt).toBe('Focus on startups');
	});

	it('sends combined criteria + location search', async () => {
		const loc = {
			displayName: 'London, United Kingdom',
			country: 'GB',
			city: 'London',
			locationType: 'city' as const
		};
		fetchSpy = mockFetchResponse({ status: 'completed', articles: [] });
		vi.stubGlobal('fetch', fetchSpy);

		await apiClient.searchPulse({
			location: loc,
			criteria: 'housing policy',
			source_mode: 'reliable'
		});

		const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
		expect(body.location.displayName).toBe('London, United Kingdom');
		expect(body.criteria).toBe('housing policy');
		expect(body.source_mode).toBe('reliable');
	});

	it('maps unauthorized beat preview errors to a clear re-login message', async () => {
		fetchSpy = mockFetchResponse(
			{
				code: 'UNAUTHORIZED_UNSUPPORTED_TOKEN_ALGORITHM',
				message: 'Unsupported JWT algorithm ES256'
			},
			401
		);
		vi.stubGlobal('fetch', fetchSpy);

		await expect(apiClient.searchPulse({ criteria: 'AI' })).rejects.toThrow(
			'Your session is no longer valid for Beat Scout preview. Please sign out and sign in again.'
		);
	});
});

// ===========================================================================
// scheduleMonitoring
// ===========================================================================

describe('scheduleMonitoring', () => {
	it('sends POST /scouts EF with full payload (post-cutover adapter)', async () => {
		const payload = {
			name: 'my-scout',
			url: 'https://example.com',
			criteria: 'price changes',
			regularity: 'daily' as const,
			day_number: 1,
			time: '09:00',
			channel: 'website' as const,
			monitoring: 'EMAIL' as const
		};

		fetchSpy = mockFetchResponse({ success: true });
		vi.stubGlobal('fetch', fetchSpy);

		await apiClient.scheduleMonitoring(payload);

		// Adapter adds `type: 'web'` (the v1 payload doesn't carry it; the EF requires it).
		const expectedBody = { ...payload, type: 'web' };
		expect(fetchSpy).toHaveBeenCalledWith(
			'/api/scouts',
			expect.objectContaining({
				method: 'POST',
					body: JSON.stringify(expectedBody)
			})
		);
	});
});

describe('scheduleLocalScout', () => {
	it('maps legacy pulse scout_type to beat and preserves beat fields', async () => {
		fetchSpy = mockFetchResponse({ success: true });
		vi.stubGlobal('fetch', fetchSpy);

		await apiClient.scheduleLocalScout({
			name: 'beat scout',
			scout_type: 'pulse',
			regularity: 'weekly',
			day_number: 2,
			time: '09:00',
			monitoring: 'EMAIL',
			criteria: 'housing policy',
			location: {
				displayName: 'London, United Kingdom',
				country: 'GB',
				city: 'London',
				locationType: 'city'
			},
			source_mode: 'reliable',
			excluded_domains: ['example.com'],
			priority_sources: ['https://news.example.com']
		});

		const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
		expect(body.scout_type).toBe('beat');
		expect(body.criteria).toBe('housing policy');
		expect(body.source_mode).toBe('reliable');
		expect(body.excluded_domains).toEqual(['example.com']);
		expect(body.priority_sources).toEqual(['https://news.example.com']);
	});
});

// ===========================================================================
// updateUserPreferences
// ===========================================================================

describe('updateUserPreferences', () => {
	it('sends only changed fields and normalizes the response', async () => {
		fetchSpy = mockFetchResponse({ preferred_language: 'fr' });
		vi.stubGlobal('fetch', fetchSpy);

		const result = await apiClient.updateUserPreferences({ preferred_language: 'fr' });

		const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
		expect(body).toEqual({ preferred_language: 'fr' });
		expect(result).toEqual({
			success: true,
			preferred_language: 'fr',
			timezone: undefined,
			excluded_domains: undefined,
			health_notifications_enabled: undefined
		});
	});
});

// ===========================================================================
// API key management
// ===========================================================================

describe('API key management', () => {
	it('creates a key with the caller-supplied name and no synthesized fallback', async () => {
		fetchSpy = mockFetchResponse({
			key: 'cj_raw_once',
			key_id: 'key_1',
			key_prefix: 'cj_raw',
			name: 'Antigravity Windows QA',
			created_at: '2026-09-01T12:00:00Z'
		});
		vi.stubGlobal('fetch', fetchSpy);

		const result = await apiClient.createApiKey('Antigravity Windows QA');

		expect(fetchSpy).toHaveBeenCalledWith(
			'/api/api-keys',
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({ name: 'Antigravity Windows QA' })
			})
		);
		expect(result.name).toBe('Antigravity Windows QA');
		expect(fetchSpy.mock.calls[0][1].body).not.toContain('My API Key');
	});

	it('lists existing keys without changing their names', async () => {
		const response = {
			keys: [{
				key_id: 'key_existing',
				key_prefix: 'cj_existing',
				name: 'My API Key',
				created_at: '2026-08-01T12:00:00Z',
				last_used_at: null
			}],
			count: 1
		};
		fetchSpy = mockFetchResponse(response);
		vi.stubGlobal('fetch', fetchSpy);

		await expect(apiClient.listApiKeys()).resolves.toEqual(response);
		expect(fetchSpy.mock.calls[0][0]).toBe('/api/api-keys');
		expect(fetchSpy.mock.calls[0][1].method).toBe('GET');
	});
});

// ===========================================================================
// submitFeedback
// ===========================================================================

describe('submitFeedback', () => {
	it('routes feedback through the residual FastAPI /api prefix', async () => {
		fetchSpy = mockFetchResponse({ url: 'https://linear.app/buriedsignals/issue/CJ-1' });
		vi.stubGlobal('fetch', fetchSpy);

		await submitFeedback({
			title: 'Support button test',
			type: 'bug',
			description: 'Regression coverage'
		});

		expect(fetchSpy).toHaveBeenCalledWith(
			'/api/feedback',
			expect.objectContaining({
				method: 'POST',
				headers: expect.objectContaining({ 'Content-Type': 'application/json' })
			})
		);
	});
});

// ===========================================================================
// apiRequest
// ===========================================================================

describe('apiRequest', () => {
	it('does not try to parse JSON for 204 No Content responses', async () => {
		const json = vi.fn();
		fetchSpy = vi.fn().mockResolvedValue({
			ok: true,
			status: 204,
			json,
			text: vi.fn()
		});
		vi.stubGlobal('fetch', fetchSpy);

		await expect(apiRequest('DELETE', '/api-keys/key_1')).resolves.toBeUndefined();
		expect(json).not.toHaveBeenCalled();
	});
});

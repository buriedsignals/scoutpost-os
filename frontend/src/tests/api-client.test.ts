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
			'/api/scouts',
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
// deleteActiveJob
// ===========================================================================

describe('deleteActiveJob', () => {
	it('resolves name → UUID via /scouts then DELETE /scouts/:id', async () => {
		// First fetch: GET /scouts to resolve name → uuid.
		// Second fetch: DELETE /scouts/<uuid>.
		fetchSpy = vi.fn()
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: vi.fn().mockResolvedValue({
					items: [{ id: 'uuid-abc', name: 'my scout name' }]
				}),
				text: vi.fn().mockResolvedValue('')
			})
			.mockResolvedValueOnce({
				ok: true,
				status: 204,
				json: vi.fn().mockResolvedValue(undefined),
				text: vi.fn().mockResolvedValue('')
			});
		vi.stubGlobal('fetch', fetchSpy);

		await apiClient.deleteActiveJob('my scout name');

		expect(fetchSpy.mock.calls[1][0]).toBe('/api/scouts/uuid-abc');
		expect(fetchSpy.mock.calls[1][1].method).toBe('DELETE');
	});

	it('handles special characters in scout name (URL-encoded UUID path)', async () => {
		fetchSpy = vi.fn()
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: vi.fn().mockResolvedValue({
					items: [{ id: 'uuid/with&special', name: 'scout/with&special' }]
				}),
				text: vi.fn().mockResolvedValue('')
			})
			.mockResolvedValueOnce({
				ok: true,
				status: 204,
				json: vi.fn().mockResolvedValue(undefined),
				text: vi.fn().mockResolvedValue('')
			});
		vi.stubGlobal('fetch', fetchSpy);

		await apiClient.deleteActiveJob('scout/with&special');

		const url = fetchSpy.mock.calls[1][0];
		expect(url).toContain(encodeURIComponent('uuid/with&special'));
	});
});

// ===========================================================================
// runScoutNow
// ===========================================================================

describe('runScoutNow', () => {
	it('resolves name → UUID via /scouts then POSTs /scouts/:id/run', async () => {
		fetchSpy = vi.fn()
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: vi.fn().mockResolvedValue({
					items: [{ id: 'uuid-run', name: 'test-scout' }]
				}),
				text: vi.fn().mockResolvedValue('')
			})
			.mockResolvedValueOnce({
				ok: true,
				status: 202,
				json: vi.fn().mockResolvedValue({ run_id: 'r-1' }),
				text: vi.fn().mockResolvedValue('{"run_id":"r-1"}')
			});
		vi.stubGlobal('fetch', fetchSpy);

		const result = await apiClient.runScoutNow('test-scout');

		expect(fetchSpy.mock.calls[1][0]).toBe('/api/scouts/uuid-run/run');
		expect(fetchSpy.mock.calls[1][1].method).toBe('POST');
		// Adapter synthesizes a "queued" response since EF returns 202 only.
		expect(result.scraper_status).toBe(true);
		expect(result.summary).toBe('Scout run queued');
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

	it('sends location search', async () => {
		const loc = { displayName: 'Zurich', country: 'CH', state: 'Zurich', city: 'Zurich', locationType: 'city' as const, maptilerId: 'maptiler-123' };
		fetchSpy = mockFetchResponse({ status: 'completed', articles: [] });
		vi.stubGlobal('fetch', fetchSpy);

		await apiClient.searchPulse({ location: loc });

		const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
		expect(body.location.displayName).toBe('Zurich');
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
// Information Units API
// ===========================================================================

describe('Information Units', () => {
	it('getUserUnitLocations uses the units compatibility route', async () => {
		fetchSpy = mockFetchResponse({
			locations: ['CH#Bern#Bern', 'CH#Zurich#Zurich']
		});
		vi.stubGlobal('fetch', fetchSpy);

		const result = await apiClient.getUserUnitLocations();

		expect(fetchSpy.mock.calls[0][0]).toBe('/api/units/locations');
		expect(result.locations).toEqual(['CH#Bern#Bern', 'CH#Zurich#Zurich']);
	});

	it('getUnitsByTopic uses the compatibility route', async () => {
		fetchSpy = mockFetchResponse({
			units: [
				{ unit_id: 'u1', topic: 'Climate' },
			],
			count: 1
		});
		vi.stubGlobal('fetch', fetchSpy);

		const result = await apiClient.getUnitsByTopic({ topic: 'Climate' });

		const url: string = fetchSpy.mock.calls[0][0];
		expect(url).toBe('/api/units/by-topic?topic=Climate');
		expect(result.units).toHaveLength(1);
		expect(result.count).toBe(1);
	});

	it('searchUnitsSemantic passes query param', async () => {
		fetchSpy = mockFetchResponse({ units: [], count: 0, query: 'AI' });
		vi.stubGlobal('fetch', fetchSpy);

		await apiClient.searchUnitsSemantic({ query: 'AI' });

		const url: string = fetchSpy.mock.calls[0][0];
		expect(url).toContain('query=AI');
	});

	it('markUnitsUsed sends PATCH with unit keys', async () => {
		fetchSpy = mockFetchResponse({ marked_count: 2, total_requested: 2 });
		vi.stubGlobal('fetch', fetchSpy);

		const keys = [
			{ pk: 'USER#123', sk: 'UNIT#abc' },
			{ pk: 'USER#123', sk: 'UNIT#def' }
		];
		await apiClient.markUnitsUsed(keys);

		expect(fetchSpy).toHaveBeenCalledWith(
			'/api/units/mark-used',
			expect.objectContaining({
				method: 'PATCH',
					body: JSON.stringify({ unit_keys: keys })
			})
		);
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

// ===========================================================================
// Cookie-based auth
// ===========================================================================

describe('Bearer auth', () => {
	it('all requests omit credentials (Authorization attached only when token exists)', async () => {
		fetchSpy = mockFetchResponse({ scrapers: [] });
		vi.stubGlobal('fetch', fetchSpy);

		await apiClient.getActiveJobs();

		const options = fetchSpy.mock.calls[0][1];
		// credentials dropped — Supabase Edge Functions return '*' origin;
		// browsers reject credentials:'include' with wildcard CORS.
		expect(options.credentials).toBeUndefined();
		expect(options.headers['Content-Type']).toBe('application/json');
		// In this test the authStore is unmocked, so getToken returns null and
		// no Authorization header is attached. api-client-workspace.test.ts
		// covers the Bearer-token-present path with a mocked authStore.
	});
});

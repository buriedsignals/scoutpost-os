/**
 * Tests for the v2 `workspaceApi` surface — verifies per-helper request URL,
 * method, body, auth header, envelope tolerance, and error normalization.
 *
 * Mock strategy mirrors `api-client.test.ts`:
 *   - `$lib/config/api.buildApiUrl` resolves to `/api${path}`
 *   - `$lib/stores/auth.authStore.getToken` returns a fixed token so Bearer
 *     header assertions are deterministic.
 *   - `vi.stubGlobal('fetch', ...)` controls the response body + status.
 *
 * Envelope coverage: every list helper is asserted to unwrap BOTH the
 * FastAPI-style `{data: [...]}` and the Edge Function `{items, pagination}`
 * envelopes into the same typed return.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/config/api', () => ({
	API_BASE_URL: '/api',
	buildApiUrl: (path: string) => `/api${path.startsWith('/') ? path : '/' + path}`
}));

vi.mock('$lib/stores/auth', () => ({
	authStore: {
		getToken: vi.fn(async () => 'test-token-xyz')
	}
}));

import { workspaceApi, ApiError, normalizeApiError } from '$lib/api-client';

// ---- Test helpers ----

function mockFetchResponse(
	body: unknown,
	status = 200,
	opts: { text?: boolean } = {}
): ReturnType<typeof vi.fn> {
	const ok = status >= 200 && status < 300;
	return vi.fn().mockResolvedValue({
		ok,
		status,
		statusText: ok ? 'OK' : 'Error',
		json: vi.fn().mockImplementation(async () => {
			if (opts.text) throw new SyntaxError('not json');
			return body;
		}),
		text: vi.fn().mockImplementation(async () => {
			if (opts.text) return body as string;
			return JSON.stringify(body);
		})
	});
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
	vi.clearAllMocks();
	fetchSpy = mockFetchResponse({});
	vi.stubGlobal('fetch', fetchSpy);
});

function getLastRequest() {
	const call = fetchSpy.mock.calls[0];
	return { url: call[0] as string, init: call[1] as RequestInit };
}

// ===========================================================================
// normalizeApiError
// ===========================================================================

describe('normalizeApiError', () => {
	it('prefers Edge Function {error, code} shape', () => {
		const out = normalizeApiError(
			{ status: 404 },
			{ error: 'not found', code: 'NOT_FOUND' }
		);
		expect(out.message).toBe('not found');
		expect(out.code).toBe('NOT_FOUND');
	});

	it('falls back to FastAPI {detail: string}', () => {
		const out = normalizeApiError({ status: 400 }, { detail: 'bad request' });
		expect(out.message).toBe('bad request');
		expect(out.code).toBeUndefined();
	});

	it('joins FastAPI validation arrays', () => {
		const out = normalizeApiError(
			{ status: 422 },
			{ detail: [{ msg: 'name required' }, { msg: 'url invalid' }] }
		);
		expect(out.message).toBe('name required; url invalid');
	});

	it('HTTP status fallback when body has neither shape', () => {
		const out = normalizeApiError({ status: 500, statusText: 'Server Error' }, null);
		expect(out.message).toBe('HTTP 500 Server Error');
	});
});

// ===========================================================================
// Auth header
// ===========================================================================

describe('auth header', () => {
	it('sends Bearer <token> when authStore.getToken returns a string', async () => {
		fetchSpy = mockFetchResponse({ items: [], pagination: { has_more: false } });
		vi.stubGlobal('fetch', fetchSpy);
		await workspaceApi.listUnits(null);
		const { init } = getLastRequest();
		const headers = init.headers as Record<string, string>;
		expect(headers.Authorization).toBe('Bearer test-token-xyz');
		// credentials dropped — Supabase Edge Functions return '*' origin;
		// browsers reject credentials:'include' with wildcard CORS.
		expect(init.credentials).toBeUndefined();
	});

	it('omits Authorization when getToken returns null', async () => {
		const { authStore } = await import('$lib/stores/auth');
		vi.mocked(authStore.getToken).mockResolvedValueOnce(null);
		fetchSpy = mockFetchResponse({ items: [], pagination: { has_more: false } });
		vi.stubGlobal('fetch', fetchSpy);
		await workspaceApi.listUnits(null);
		const headers = getLastRequest().init.headers as Record<string, string>;
		expect(headers.Authorization).toBeUndefined();
		expect(getLastRequest().init.credentials).toBeUndefined();
	});
});

// ===========================================================================
// listScouts — GET /scouts?project_id=&limit=&offset=
// ===========================================================================

describe('listScouts', () => {
	it('preserves pagination metadata so the workspace can load more scouts', async () => {
		const items = [{ id: 's1', name: 'Scout 1', type: 'pulse', is_active: true }];
		fetchSpy = mockFetchResponse({
			items,
			pagination: { total: 51, offset: 0, limit: 50, has_more: true }
		});
		vi.stubGlobal('fetch', fetchSpy);
		const page = await workspaceApi.listScouts('p1');
		const { url } = getLastRequest();
		expect(url).toContain('/api/scouts');
		expect(url).toContain('project_id=p1');
		expect(url).toContain('limit=50');
		expect(page.scouts).toEqual(items);
		expect(page.next_cursor).toBe('50');
		expect(page.total).toBe(51);
	});

	it('tolerates FastAPI {scouts: [...], count} envelope', async () => {
		const scouts = [{ id: 's2', name: 'Scout 2', type: 'web', is_active: true }];
		fetchSpy = mockFetchResponse({ scouts, count: 1 });
		vi.stubGlobal('fetch', fetchSpy);
		const got = await workspaceApi.listScouts();
		expect(got.scouts).toEqual(scouts);
		expect(got.next_cursor).toBeNull();
	});

	it('normalizes legacy scout types from live data', async () => {
		fetchSpy = mockFetchResponse({
			items: [{ id: 's3', name: 'Legacy Beat', type: 'beat', is_active: true }],
			pagination: { has_more: false }
		});
		vi.stubGlobal('fetch', fetchSpy);
		const got = await workspaceApi.listScouts();
		expect(got.scouts[0].type).toBe('pulse');
	});

	it('omits project_id when not supplied', async () => {
		fetchSpy = mockFetchResponse({ items: [], pagination: { has_more: false } });
		vi.stubGlobal('fetch', fetchSpy);
		await workspaceApi.listScouts();
		expect(getLastRequest().url).toBe('/api/scouts?limit=50&offset=0');
	});
});

// ===========================================================================
// runScout — POST /scouts/:id/run
// ===========================================================================

describe('runScout', () => {
	it('POSTs and returns {run_id}', async () => {
		fetchSpy = mockFetchResponse({ scout_id: 's1', run_id: 'r-42' }, 202);
		vi.stubGlobal('fetch', fetchSpy);
		const got = await workspaceApi.runScout('s1');
		expect(getLastRequest().url).toBe('/api/scouts/s1/run');
		expect(getLastRequest().init.method).toBe('POST');
		expect(got.run_id).toBe('r-42');
	});
});

// ===========================================================================
// listUnits — GET /units?scout_id=&limit=&offset=
// ===========================================================================

describe('listUnits', () => {
	it('returns {units, next_cursor} from Edge Function envelope when has_more', async () => {
		const items = [{ id: 'u1', statement: 'x' }];
		fetchSpy = mockFetchResponse({
			items,
			pagination: { total: 200, offset: 0, limit: 50, has_more: true }
		});
		vi.stubGlobal('fetch', fetchSpy);

		const page = await workspaceApi.listUnits('s1');
		const { url } = getLastRequest();
		expect(url).toContain('/api/units');
		expect(url).toContain('scout_id=s1');
		expect(url).toContain('limit=50');
		expect(page.units).toEqual(items);
		expect(page.next_cursor).toBe('50');
	});

	it('returns next_cursor=null when no more pages', async () => {
		fetchSpy = mockFetchResponse({
			items: [],
			pagination: { total: 0, offset: 0, limit: 50, has_more: false }
		});
		vi.stubGlobal('fetch', fetchSpy);
		const page = await workspaceApi.listUnits(null);
		expect(page.next_cursor).toBeNull();
	});

	it('respects an incoming cursor', async () => {
		fetchSpy = mockFetchResponse({
			items: [],
			pagination: { total: 0, offset: 100, limit: 50, has_more: false }
		});
		vi.stubGlobal('fetch', fetchSpy);
		await workspaceApi.listUnits('s1', '100');
		expect(getLastRequest().url).toContain('offset=100');
	});

	it('tolerates FastAPI {units: [...]} envelope (no pagination block)', async () => {
		fetchSpy = mockFetchResponse({ units: [{ id: 'u1' }], count: 1 });
		vi.stubGlobal('fetch', fetchSpy);
		const page = await workspaceApi.listUnits(null);
		expect(page.units).toEqual([{ id: 'u1' }]);
		expect(page.next_cursor).toBeNull();
	});

	it('throws ApiError on server error', async () => {
		fetchSpy = mockFetchResponse({ error: 'boom' }, 500);
		vi.stubGlobal('fetch', fetchSpy);
		await expect(workspaceApi.listUnits(null)).rejects.toBeInstanceOf(ApiError);
	});
});

describe('deleteUnit', () => {
	it('DELETEs a unit by id', async () => {
		fetchSpy = mockFetchResponse(null, 204);
		vi.stubGlobal('fetch', fetchSpy);

		await workspaceApi.deleteUnit('u1');
		const { url, init } = getLastRequest();
		expect(url).toBe('/api/units/u1');
		expect(init.method).toBe('DELETE');
	});
});

// ===========================================================================
// searchUnits — POST /units/search
// ===========================================================================

describe('searchUnits', () => {
	it('POSTs {query_text, scout_id?} and unwraps {items}', async () => {
		const items = [{ id: 'u1', statement: 'match' }];
		fetchSpy = mockFetchResponse({ items });
		vi.stubGlobal('fetch', fetchSpy);

		const got = await workspaceApi.searchUnits('AI', 's1');
		const { url, init } = getLastRequest();
		expect(url).toBe('/api/units/search');
		expect(init.method).toBe('POST');
		expect(JSON.parse(init.body as string)).toEqual({ query_text: 'AI', scout_id: 's1' });
		expect(got).toEqual(items);
	});

	it('unwraps FastAPI {data: [...]} envelope', async () => {
		const items = [{ id: 'u2', statement: 'y' }];
		fetchSpy = mockFetchResponse({ data: items });
		vi.stubGlobal('fetch', fetchSpy);
		const got = await workspaceApi.searchUnits('y');
		expect(got).toEqual(items);
	});
});

// ===========================================================================
// promoteUnit / rejectUnit — PATCH /units/:id
// ===========================================================================

describe('promoteUnit / rejectUnit', () => {
	it('promoteUnit PATCHes verified=true', async () => {
		fetchSpy = mockFetchResponse({ id: 'u1', statement: 'x' });
		vi.stubGlobal('fetch', fetchSpy);
		await workspaceApi.promoteUnit('u1');
		const { url, init } = getLastRequest();
		expect(url).toBe('/api/units/u1');
		expect(init.method).toBe('PATCH');
		expect(JSON.parse(init.body as string)).toEqual({ verified: true });
	});

	it('rejectUnit PATCHes verified=false + notes', async () => {
		fetchSpy = mockFetchResponse({ id: 'u1', statement: 'x' });
		vi.stubGlobal('fetch', fetchSpy);
		await workspaceApi.rejectUnit('u1');
		expect(JSON.parse(getLastRequest().init.body as string)).toEqual({
			verified: false,
			verification_notes: 'rejected'
		});
	});

	it('throws normalized error on PATCH failure (Edge Function shape)', async () => {
		fetchSpy = mockFetchResponse({ error: 'not found', code: 'NOT_FOUND' }, 404);
		vi.stubGlobal('fetch', fetchSpy);
		await expect(workspaceApi.promoteUnit('missing')).rejects.toMatchObject({
			message: 'not found',
			code: 'NOT_FOUND',
			status: 404
		});
	});
});

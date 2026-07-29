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
// ApiError class
// ===========================================================================

describe('ApiError', () => {
	it('exposes message / code / status', () => {
		const err = new ApiError('boom', 'CODE_X', 418);
		expect(err.message).toBe('boom');
		expect(err.code).toBe('CODE_X');
		expect(err.status).toBe(418);
		expect(err.name).toBe('ApiError');
		expect(err).toBeInstanceOf(Error);
	});
});

// ===========================================================================
// Auth header
// ===========================================================================

describe('auth header', () => {
	it('sends Bearer <token> when authStore.getToken returns a string', async () => {
		fetchSpy = mockFetchResponse({ items: [], pagination: { has_more: false } });
		vi.stubGlobal('fetch', fetchSpy);
		await workspaceApi.listProjects();
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
		await workspaceApi.listProjects();
		const headers = getLastRequest().init.headers as Record<string, string>;
		expect(headers.Authorization).toBeUndefined();
		expect(getLastRequest().init.credentials).toBeUndefined();
	});
});

// ===========================================================================
// listProjects — GET /projects
// ===========================================================================

describe('listProjects', () => {
	it('unwraps Edge Function {items, pagination} envelope', async () => {
		const items = [{ id: 'p1', name: 'Project 1', created_at: 'now' }];
		fetchSpy = mockFetchResponse({ items, pagination: { has_more: false, total: 1 } });
		vi.stubGlobal('fetch', fetchSpy);

		const projects = await workspaceApi.listProjects();
		expect(getLastRequest().url).toBe('/api/projects');
		expect(getLastRequest().init.method).toBe('GET');
		expect(projects).toEqual(items);
	});

	it('unwraps FastAPI {data: [...]} envelope', async () => {
		const items = [{ id: 'p2', name: 'Project 2', created_at: 'now' }];
		fetchSpy = mockFetchResponse({ data: items });
		vi.stubGlobal('fetch', fetchSpy);

		const projects = await workspaceApi.listProjects();
		expect(projects).toEqual(items);
	});

	it('normalizes Edge Function error', async () => {
		fetchSpy = mockFetchResponse({ error: 'unauthorized', code: 'AUTH' }, 401);
		vi.stubGlobal('fetch', fetchSpy);

		let caught: unknown;
		try {
			await workspaceApi.listProjects();
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(ApiError);
		const err = caught as ApiError;
		expect(err.message).toBe('unauthorized');
		expect(err.code).toBe('AUTH');
		expect(err.status).toBe(401);
	});
});

// ===========================================================================
// getProject — GET /projects/:id
// ===========================================================================

describe('getProject', () => {
	it('fetches a single project', async () => {
		const p = { id: 'p1', name: 'X', created_at: 'now' };
		fetchSpy = mockFetchResponse(p);
		vi.stubGlobal('fetch', fetchSpy);
		const project = await workspaceApi.getProject('p1');
		expect(getLastRequest().url).toBe('/api/projects/p1');
		expect(project).toEqual(p);
	});

	it('url-encodes the id', async () => {
		fetchSpy = mockFetchResponse({ id: 'weird/id', name: 'X', created_at: 'now' });
		vi.stubGlobal('fetch', fetchSpy);
		await workspaceApi.getProject('weird/id');
		expect(getLastRequest().url).toContain(encodeURIComponent('weird/id'));
	});

	it('throws ApiError on 404 (FastAPI detail shape)', async () => {
		fetchSpy = mockFetchResponse({ detail: 'project not found' }, 404);
		vi.stubGlobal('fetch', fetchSpy);
		await expect(workspaceApi.getProject('missing')).rejects.toMatchObject({
			message: 'project not found',
			status: 404
		});
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
// createScout — POST /scouts
// ===========================================================================

describe('createScout', () => {
	it('POSTs body and returns the server row', async () => {
		const serverRow = {
			id: 's1',
			name: 'New Scout',
			type: 'pulse',
			is_active: false
		};
		fetchSpy = mockFetchResponse(serverRow, 201);
		vi.stubGlobal('fetch', fetchSpy);

		const input = { name: 'New Scout', type: 'pulse' as const, criteria: 'AI' };
		const got = await workspaceApi.createScout(input);

		const { url, init } = getLastRequest();
		expect(url).toBe('/api/scouts');
		expect(init.method).toBe('POST');
		expect(JSON.parse(init.body as string)).toEqual(input);
		expect(got).toEqual(serverRow);
	});

	it('throws ApiError on 409 conflict (Edge Function shape)', async () => {
		fetchSpy = mockFetchResponse({ error: 'already exists', code: 'CONFLICT' }, 409);
		vi.stubGlobal('fetch', fetchSpy);
		await expect(
			workspaceApi.createScout({ name: 'dup', type: 'web' })
		).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
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

// ===========================================================================
// getUnit — GET /units/:id
// ===========================================================================

describe('getUnit', () => {
	it('fetches and returns the bare unit object', async () => {
		const u = { id: 'u1', statement: 'x' };
		fetchSpy = mockFetchResponse(u);
		vi.stubGlobal('fetch', fetchSpy);
		const got = await workspaceApi.getUnit('u1');
		expect(getLastRequest().url).toBe('/api/units/u1');
		expect(got).toEqual(u);
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
// listReflections — GET /reflections
// ===========================================================================

describe('listReflections', () => {
	it('unwraps Edge Function items envelope', async () => {
		const items = [{ id: 'r1', scope_description: 'x', content: 'y', generated_by: 'agent', created_at: 'now' }];
		fetchSpy = mockFetchResponse({ items, pagination: { has_more: false } });
		vi.stubGlobal('fetch', fetchSpy);
		const got = await workspaceApi.listReflections();
		expect(getLastRequest().url).toBe('/api/reflections');
		expect(got).toEqual(items);
	});

	it('passes unit_id query param', async () => {
		fetchSpy = mockFetchResponse({ data: [] });
		vi.stubGlobal('fetch', fetchSpy);
		await workspaceApi.listReflections('u1');
		expect(getLastRequest().url).toContain('unit_id=u1');
	});
});

// ===========================================================================
// listEntities — GET /entities
// ===========================================================================

describe('listEntities', () => {
	it('unwraps Edge Function items', async () => {
		const items = [{ id: 'e1', canonical_name: 'ACME', type: 'org' }];
		fetchSpy = mockFetchResponse({ items, pagination: { has_more: false } });
		vi.stubGlobal('fetch', fetchSpy);
		const got = await workspaceApi.listEntities();
		expect(getLastRequest().url).toBe('/api/entities');
		expect(got).toEqual(items);
	});

	it('unwraps FastAPI data array', async () => {
		const items = [{ id: 'e2', canonical_name: 'X', type: 'person' }];
		fetchSpy = mockFetchResponse({ data: items });
		vi.stubGlobal('fetch', fetchSpy);
		const got = await workspaceApi.listEntities('s1');
		expect(getLastRequest().url).toContain('scout_id=s1');
		expect(got).toEqual(items);
	});
});

// ===========================================================================
// ingest — POST /ingest
// ===========================================================================

describe('ingest', () => {
	it('POSTs kind=url when url is provided', async () => {
		fetchSpy = mockFetchResponse({ ingest_id: 'i-1', raw_capture_id: 'rc-1', units: [] }, 201);
		vi.stubGlobal('fetch', fetchSpy);
		const got = await workspaceApi.ingest({ url: 'https://example.com', project_id: 'p1' });
		const { url, init } = getLastRequest();
		expect(url).toBe('/api/ingest');
		expect(init.method).toBe('POST');
		const body = JSON.parse(init.body as string);
		expect(body.kind).toBe('url');
		expect(body.url).toBe('https://example.com');
		expect(body.project_id).toBe('p1');
		expect(got.ingest_id).toBe('i-1');
		expect(got.job_id).toBe('i-1');
		expect(got.units).toEqual([]);
	});

	it('POSTs kind=text when content is provided', async () => {
		fetchSpy = mockFetchResponse({ ingest_id: 'i-2', units: [] }, 201);
		vi.stubGlobal('fetch', fetchSpy);
		await workspaceApi.ingest({ content: 'hello world'.repeat(10), project_id: 'p1' });
		const body = JSON.parse(getLastRequest().init.body as string);
		expect(body.kind).toBe('text');
		expect(body.text).toMatch(/hello world/);
	});

	it('normalizes FastAPI {detail: string} errors', async () => {
		fetchSpy = mockFetchResponse({ detail: 'invalid url' }, 400);
		vi.stubGlobal('fetch', fetchSpy);
		await expect(
			workspaceApi.ingest({ url: 'not-a-url', project_id: 'p1' })
		).rejects.toMatchObject({ message: 'invalid url', status: 400 });
	});
});

// ===========================================================================
// mergeEntities — POST /entities/merge
// ===========================================================================

describe('mergeEntities', () => {
	it('sends {keep_id, merge_ids} and returns count', async () => {
		fetchSpy = mockFetchResponse({ merged: 2 });
		vi.stubGlobal('fetch', fetchSpy);
		const got = await workspaceApi.mergeEntities(['keep', 'a', 'b']);
		const { url, init } = getLastRequest();
		expect(url).toBe('/api/entities/merge');
		expect(init.method).toBe('POST');
		expect(JSON.parse(init.body as string)).toEqual({
			keep_id: 'keep',
			merge_ids: ['a', 'b']
		});
		expect(got).toEqual({ keep_id: 'keep', merged: 2 });
	});

	it('throws before fetch when fewer than 2 ids', async () => {
		await expect(workspaceApi.mergeEntities([])).rejects.toBeInstanceOf(ApiError);
		await expect(workspaceApi.mergeEntities(['only'])).rejects.toBeInstanceOf(ApiError);
		expect(fetchSpy).not.toHaveBeenCalled();
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

/**
 * API Client -- typed wrapper for all FastAPI backend calls.
 *
 * USED BY: ActiveJobsModal, ScoutScheduleModal, BeatScoutView,
 *          stores/notifications.ts, stores/pulse.ts,
 *          tests/api-client.test.ts
 * DEPENDS ON: $lib/config/api (buildApiUrl), $lib/types
 *
 * Uses httpOnly session cookies for authentication (credentials: 'include').
 * Also exports the legacy InformationUnit type used by compatibility helpers.
 */
import type {
	MonitoringSetupRequest,
	MonitoringSetupResponse,
	GeocodedLocation,
	ScoutSetupRequest,
	ScoutSetupResponse,
	User
} from '$lib/types';

function normalizePulseSearchError(response: Response, result: Record<string, unknown> | null): string {
	if (
		response.status === 401 ||
		(typeof result?.code === 'string' && result.code.startsWith('UNAUTHORIZED_'))
	) {
		return 'Your session is no longer valid for Beat Scout preview. Please sign out and sign in again.';
	}

	return (
		(typeof result?.detail === 'string' && result.detail) ||
		(typeof result?.response_markdown === 'string' && result.response_markdown) ||
		'Failed to search pulse'
	);
}
import { buildApiUrl, buildFastApiUrl } from '$lib/config/api';
import { normalizeScoutType } from '$lib/utils/scouts';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Standard JSON headers for API requests.
 * Authentication is handled via httpOnly cookies (credentials: 'include').
 */
const JSON_HEADERS: Record<string, string> = {
	'Content-Type': 'application/json'
};

/**
 * Normalize a FastAPI error detail field into a human-readable string.
 * Handles string, array-of-objects (validation errors), and unknown shapes.
 */
function normalizeErrorDetail(detail: unknown, fallback: string): string {
	if (typeof detail === 'string') return detail;
	if (Array.isArray(detail))
		return detail.map((e: { msg?: string }) => e.msg || String(e)).join('; ');
	return fallback;
}

/**
 * Generic authenticated API request.
 * Sends Supabase Bearer token (if available) or falls back to session cookies.
 */
export async function apiRequest<T>(
	method: string,
	path: string,
	body?: unknown
): Promise<T> {
	const { authStore } = await import('$lib/stores/auth');
	const token = await authStore.getToken();
	const headers: Record<string, string> = {
		...JSON_HEADERS,
		...(token ? { Authorization: `Bearer ${token}` } : {})
	};

	const response = await fetch(buildApiUrl(path), {
		method,
		headers,
		...(body !== undefined ? { body: JSON.stringify(body) } : {})
	});

	if (!response.ok) {
		const error = await response.json().catch(() => ({}));
		throw new Error(
			normalizeErrorDetail(
				(error as { detail?: unknown; error?: unknown }).detail ??
					(error as { error?: unknown }).error,
				`API error: ${response.status}`
			)
		);
	}

	if (response.status === 204) return undefined as T;
	return response.json();
}

/**
 * Generic authenticated request for the residual FastAPI service on Render.
 * Use this only for endpoints that intentionally remain under /api instead of
 * the Supabase Edge Functions gateway.
 */
export async function fastApiRequest<T>(
	method: string,
	path: string,
	body?: unknown
): Promise<T> {
	const { authStore } = await import('$lib/stores/auth');
	const token = await authStore.getToken();
	const headers: Record<string, string> = {
		...JSON_HEADERS,
		...(token ? { Authorization: `Bearer ${token}` } : {})
	};

	const response = await fetch(buildFastApiUrl(path), {
		method,
		headers,
		...(body !== undefined ? { body: JSON.stringify(body) } : {})
	});

	if (!response.ok) {
		const error = await response.json().catch(() => ({}));
		throw new Error(
			normalizeErrorDetail(
				(error as { detail?: unknown; error?: unknown }).detail ??
					(error as { error?: unknown }).error,
				`API error: ${response.status}`
			)
		);
	}

	return response.json();
}

export interface FeedbackPayload {
	title: string;
	type: 'bug' | 'feature' | 'other';
	description?: string;
	device?: string;
	browser?: string;
	screenshot_base64?: string;
	screenshot_filename?: string;
	screenshot_content_type?: string;
}

export interface FeedbackResponse {
	url: string;
}

export async function submitFeedback(payload: FeedbackPayload): Promise<FeedbackResponse> {
	return fastApiRequest<FeedbackResponse>('POST', '/feedback', payload);
}


/**
 * Like apiRequest, but uses safe JSON parsing for error responses
 * (handles cases where the error body is not valid JSON).
 * Also checks error.error as a fallback detail field.
 */
async function apiRequestSafeError<T>(
	method: string,
	path: string,
	body: unknown,
	fallbackMessage: string
): Promise<T> {
	const { authStore } = await import('$lib/stores/auth');
	const token = await authStore.getToken();
	const headers: Record<string, string> = {
		...JSON_HEADERS,
		...(token ? { Authorization: `Bearer ${token}` } : {})
	};

	const response = await fetch(buildApiUrl(path), {
		method,
		headers,
		body: JSON.stringify(body)
	});

	if (!response.ok) {
		let detail = fallbackMessage;
		try {
			const error = await response.json();
			detail = normalizeErrorDetail(error.detail, '') || error.error || detail;
		} catch {
			// Response body is not valid JSON
		}
		throw new Error(detail);
	}

	return response.json();
}

/**
 * Build a query string from an object, omitting undefined/null values.
 * Number values are converted to strings.
 */
function buildQueryString(params: Record<string, string | number | undefined | null>): string {
	const searchParams = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value != null) {
			searchParams.set(key, String(value));
		}
	}
	return searchParams.toString();
}

// ---------------------------------------------------------------------------
// API Client
// ---------------------------------------------------------------------------

/**
 * API Client for backend communication.
 *
 * MIGRATION NOTE (2026-04-22 cutover): the legacy v1 paths below
 * (`/scrapers/*`, `/auth/me`) only existed on FastAPI. After flipping
 * VITE_API_URL to the Supabase Edge Functions URL, those paths return
 * 404. Each method in this section is now an adapter that calls the
 * equivalent Edge Function (mostly `scouts`) and reshapes the response
 * to preserve the v1 contract — so UI components don't need changes.
 *
 * The new `workspaceApi` further down the file already targets Edge
 * Functions natively. The two surfaces will be unified once the legacy
 * UI components migrate to workspaceApi (POST-CUTOVER-TODO #2).
 */

// Helper: resolve a legacy scout NAME (string) to a v2 scout UUID.
// Performs a single GET /scouts and matches by name. Cached per session
// in module scope so a sequence of run-now/delete calls only pays the
// lookup once. Cache invalidates on any list refetch.
let _scoutNameToIdCache: Map<string, string> | null = null;
async function resolveScoutId(scraperName: string): Promise<string> {
	if (_scoutNameToIdCache?.has(scraperName)) {
		return _scoutNameToIdCache.get(scraperName)!;
	}
	const { authStore } = await import('$lib/stores/auth');
	const token = await authStore.getToken();
	const response = await fetch(buildApiUrl('/scouts'), {
		method: 'GET',
		headers: { ...JSON_HEADERS, ...(token ? { Authorization: `Bearer ${token}` } : {}) }
	});
	if (!response.ok) throw new Error(`Failed to resolve scout name "${scraperName}"`);
	const body = (await response.json()) as { items?: Array<{ id: string; name: string }> };
	const cache = new Map<string, string>();
	for (const item of body.items ?? []) cache.set(item.name, item.id);
	_scoutNameToIdCache = cache;
	const id = cache.get(scraperName);
	if (!id) throw new Error(`Scout "${scraperName}" not found`);
	return id;
}

export const apiClient = {
	/**
	 * Get all active monitoring jobs.
	 *
	 * Adapter: calls Edge Function GET /scouts (paginated `{items, pagination}`)
	 * and reshapes to the legacy `{scrapers: [{scraper_name, ...}], count}`
	 * envelope expected by legacy scout-management callers. Refreshes the
	 * name→id resolve cache on every list fetch.
	 */
	async getActiveJobs(): Promise<import('$lib/types').ActiveJobsResponse> {
		const { authStore } = await import('$lib/stores/auth');
		const token = await authStore.getToken();
		const response = await fetch(buildApiUrl('/scouts'), {
			method: 'GET',
			headers: { ...JSON_HEADERS, ...(token ? { Authorization: `Bearer ${token}` } : {}) }
		});
		if (!response.ok) {
			throw new Error(normalizeErrorDetail(undefined, `API error: ${response.status}`));
		}
		const body = (await response.json()) as {
			items?: Array<Record<string, unknown> & { id: string; name: string }>;
			pagination?: { total?: number };
		};
		const items = body.items ?? [];
		// Refresh the resolve cache as a side effect.
		const cache = new Map<string, string>();
		for (const item of items) cache.set(item.name, item.id);
		_scoutNameToIdCache = cache;
		// Reshape each item: surface legacy `scraper_name` alongside `name`.
		const scrapers = items.map((item) => ({
			...item,
			scraper_name: item.name
		}));
		// `user` is a legacy field on ActiveJobsResponse — synthesize from
		// the supabase session (UI consumers don't actually read it after
		// the v2 cutover, but the type still requires it).
		const user = items[0]?.user_id ?? '';
		return {
			user: String(user),
			scrapers
		} as unknown as import('$lib/types').ActiveJobsResponse;
	},

	/**
	 * Delete an active monitoring job by name.
	 *
	 * Adapter: resolves name → UUID, then DELETE /scouts/:id.
	 */
	async deleteActiveJob(scraperName: string): Promise<void> {
		const id = await resolveScoutId(scraperName);
		const { authStore } = await import('$lib/stores/auth');
		const token = await authStore.getToken();
		const response = await fetch(buildApiUrl(`/scouts/${encodeURIComponent(id)}`), {
			method: 'DELETE',
			headers: { ...JSON_HEADERS, ...(token ? { Authorization: `Bearer ${token}` } : {}) }
		});
		if (!response.ok && response.status !== 204) {
			let detail = 'Failed to delete monitoring job';
			try {
				const error = await response.json();
				detail = error.detail || error.error || detail;
			} catch {
				/* non-JSON */
			}
			throw new Error(detail);
		}
		// Invalidate cache after delete.
		_scoutNameToIdCache = null;
		if (response.status === 204) return;
		return response.json();
	},

	/**
	 * Schedule a monitoring job for a scraper.
	 *
	 * Adapter: maps the legacy MonitoringSetupRequest body to the EF
	 * POST /scouts shape. We map best-effort; UI consumers get the
	 * shaped response back even if EF returns a richer shape.
	 */
	async scheduleMonitoring(payload: MonitoringSetupRequest): Promise<MonitoringSetupResponse> {
		// scheduleMonitoring is the web-scout entry point; the v1 payload
		// shape doesn't include `type`, so add it explicitly. The EF derives
		// schedule_cron from regularity + day_number + time server-side.
		const body = { ...payload, type: 'web' as const };
		const res = await apiRequestSafeError<Record<string, unknown>>(
			'POST',
			'/scouts',
			body as unknown,
			'Failed to schedule monitoring'
		);
		return res as unknown as MonitoringSetupResponse;
	},

	/**
	 * Schedule a local scout (pulse / social / civic).
	 *
	 * Adapter: same as scheduleMonitoring — POST /scouts. The legacy v1 shape
	 * carries the discriminator as `scout_type`; the EF accepts it as an alias
	 * for `type` (see normalizeScoutBody). Forward as-is.
	 */
	async scheduleLocalScout(payload: ScoutSetupRequest): Promise<ScoutSetupResponse> {
		const body =
			payload.scout_type === 'pulse'
				? { ...payload, scout_type: 'beat' as const }
				: payload;
		const res = await apiRequestSafeError<Record<string, unknown>>(
			'POST',
			'/scouts',
			body as unknown,
			'Failed to schedule local scout'
		);
		return res as unknown as ScoutSetupResponse;
	},

	/**
	 * Manually trigger a scout execution ("Run Now").
	 *
	 * Adapter: resolves name → UUID, POSTs to /scouts/:id/run. The Edge
	 * Function returns 202 + run_id (async), not the legacy sync result
	 * shape. We synthesize a "queued" response so the UI's success path
	 * fires; the spinner stop is POST-CUTOVER-TODO #3 (separate fix).
	 */
	async runScoutNow(scraperName: string): Promise<{
		scraper_status: boolean;
		criteria_status: boolean;
		summary: string;
		notification_sent?: boolean;
		change_status?: string;
	}> {
		const id = await resolveScoutId(scraperName);
		await apiRequestSafeError<Record<string, unknown>>(
			'POST',
			`/scouts/${encodeURIComponent(id)}/run`,
			{},
			'Failed to run scout'
		);
		return {
			scraper_status: true,
			criteria_status: false,
			summary: 'Scout run queued',
			notification_sent: false
		};
	},

	/**
	 * Get authentication status. Does not throw on errors.
	 *
	 * Adapter: was hitting the FastAPI /auth/me shim (now removed). The
	 * Edge Function `user` exposes /user/me — use that. If it fails,
	 * the supabase session itself is the source of truth (handled in
	 * auth-supabase.ts init); this helper just reports current state.
	 */
	async getAuthStatus(): Promise<{ authenticated: boolean; user: User | null }> {
		try {
			const { authStore } = await import('$lib/stores/auth');
			const token = await authStore.getToken();
			if (!token) return { authenticated: false, user: null };
			const response = await fetch(buildApiUrl('/user/me'), {
				method: 'GET',
				headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` }
			});

			if (!response.ok) {
				return { authenticated: false, user: null };
			}

			const user = await response.json();
			return { authenticated: true, user };
		} catch {
			return { authenticated: false, user: null };
		}
	},

	/**
	 * AI-orchestrated pulse search.
	 * Returns AI-curated news articles for a location and/or topic (~30-60s).
	 */
	async searchPulse(filters: {
		location?: GeocodedLocation;
		category?: import('$lib/types').SearchCategory;
		custom_filter_prompt?: string;
		source_mode?: 'reliable' | 'niche';
		criteria?: string;
		excluded_domains?: string[];
		priority_sources?: string[];
	}): Promise<import('$lib/types').PulseSearchResponse> {
		if (!filters.location && !filters.criteria) {
			throw new Error('Location or criteria is required for pulse search');
		}

		const body: Record<string, unknown> = {
			category: filters.category || 'news',
			custom_filter_prompt: filters.custom_filter_prompt || undefined
		};
		if (filters.location) body.location = filters.location;
		if (filters.source_mode) body.source_mode = filters.source_mode;
		if (filters.criteria) body.criteria = filters.criteria;
		if (filters.excluded_domains?.length) body.excluded_domains = filters.excluded_domains;
		if (filters.priority_sources?.length) body.priority_sources = filters.priority_sources;

		const { authStore } = await import('$lib/stores/auth');
		const token = await authStore.getToken();
		const response = await fetch(buildApiUrl('/beat-search'), {
			method: 'POST',
			headers: { ...JSON_HEADERS, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
			/* credentials dropped — Supabase Edge Functions return '*' origin; browsers reject credentials with wildcards */
			body: JSON.stringify(body)
		});

		let result: Record<string, unknown> | null;
		try {
			result = await response.json();
		} catch {
			const textError = await response.text().catch(() => 'Unknown server error');
			console.error('[API] searchPulse received non-JSON response:', textError);
			throw new Error(`Server error: ${textError || 'Unknown error'}`);
		}

		if (!response.ok || result?.status === 'failed') {
			console.error('[API] searchPulse error:', result);
			throw new Error(normalizePulseSearchError(response, result));
		}

		return result as unknown as import('$lib/types').PulseSearchResponse;
	},

	/**
	 * Discover council/civic pages for a root domain.
	 * Returns candidate URLs found on the council website.
	 */
	async discoverCivic(rootDomain: string): Promise<{
		candidates: Array<{ url: string; description: string; confidence: number }>;
	}> {
		return apiRequest('POST', '/civic/discover', {
			root_domain: rootDomain,
		});
	},

	/**
	 * Test civic scout extraction on selected URLs.
	 * Returns preview of extracted promises without storing anything.
	 */
	async testCivic(trackedUrls: string[], criteria?: string): Promise<{
		valid: boolean;
		documents_found: number;
		sample_promises: Array<{ promise_text: string; context: string; source_url: string; source_date: string; due_date?: string; date_confidence: string; criteria_match: boolean }>;
		error?: string;
	}> {
		return apiRequest('POST', '/civic/test', {
			tracked_urls: trackedUrls,
			...(criteria ? { criteria } : {}),
		});
	},

	// ==================== Information Units API ====================

	/**
	 * Get distinct locations where user has information units.
	 *
	 * Adapter: the units EF doesn't expose /units/locations, so we
	 * aggregate client-side: fetch a page of units and dedupe distinct
	 * country/state/city combinations into displayName-shaped strings.
	 * 200-unit cap keeps the request bounded; if a user has more they
	 * see the most-recent locations only (acceptable for filter UX).
	 */
	async getUserUnitLocations(): Promise<{ locations: string[] }> {
		return apiRequest('GET', '/units/locations');
	},

	/**
	 * Get all unused information units (no location/topic filter).
	 */
	async getAllUnusedUnits(limit: number = 50): Promise<{
		units: InformationUnit[];
		count: number;
	}> {
		const qs = buildQueryString({ limit });
		return apiRequest('GET', `/units/all?${qs}`);
	},

	/**
	 * Get only unused information units for a location.
	 */
	async getUnusedUnitsByLocation(params: {
		country: string;
		state?: string;
		city?: string;
		displayName: string;
		limit?: number;
	}): Promise<{
		units: InformationUnit[];
		count: number;
	}> {
		const qs = buildQueryString({
			country: params.country,
			state: params.state,
			city: params.city,
			displayName: params.displayName,
			limit: params.limit
		});
		return apiRequest('GET', `/units/unused?${qs}`);
	},

	/**
	 * Mark units as used in an article.
	 */
	async markUnitsUsed(unitKeys: { pk: string; sk: string }[]): Promise<{
		marked_count: number;
		total_requested: number;
	}> {
		return apiRequest('PATCH', '/units/mark-used', { unit_keys: unitKeys });
	},

	/**
	 * Update user preferences (language, timezone, and/or excluded domains).
	 */
	async updateUserPreferences(params: {
		preferred_language?: string;
		timezone?: string;
		excluded_domains?: string[];
		health_notifications_enabled?: boolean;
	}): Promise<{
		success: boolean;
		preferred_language?: string;
		timezone?: string;
		excluded_domains?: string[];
		health_notifications_enabled?: boolean;
	}> {
		const response = await apiRequest<Record<string, unknown>>('PATCH', '/user/preferences', params);
		return {
			success: true,
			preferred_language:
				typeof response.preferred_language === 'string'
					? response.preferred_language
					: params.preferred_language,
			timezone: typeof response.timezone === 'string' ? response.timezone : params.timezone,
			excluded_domains: Array.isArray(response.excluded_domains)
				? (response.excluded_domains as string[])
				: params.excluded_domains,
			health_notifications_enabled:
				typeof response.health_notifications_enabled === 'boolean'
					? response.health_notifications_enabled
					: params.health_notifications_enabled
		};
	},

	/**
	 * Get distinct topics where user has information units.
	 *
	 * Adapter: aggregate client-side from a single GET /units page,
	 * same approach as getUserUnitLocations. 200-unit cap.
	 */
	async getUserUnitTopics(): Promise<{ topics: string[] }> {
		return apiRequest('GET', '/units/topics');
	},

	/**
	 * Get information units for a specific topic.
	 *
	 * Adapter: client-side filter on a GET /units page. The units EF
	 * doesn't (yet) accept topic as a filter param; rather than ship
	 * a server-side EF change at 1AM, filter the result locally. 200-
	 * unit cap. Server-side topic filter is a small EF patch for the
	 * morning.
	 */
	async getUnitsByTopic(params: {
		topic: string;
		limit?: number;
	}): Promise<{
		units: InformationUnit[];
		count: number;
	}> {
		const qs = buildQueryString({
			topic: params.topic,
			limit: params.limit
		});
		return apiRequest('GET', `/units/by-topic?${qs}`);
	},

	/**
	 * Semantic search across information units.
	 */
	async searchUnitsSemantic(params: {
		country?: string;
		state?: string;
		city?: string;
		displayName?: string;
		topic?: string;
		query: string;
		limit?: number;
	}): Promise<{
		units: (InformationUnit & { similarity_score: number })[];
		count: number;
		query: string;
	}> {
		const qs = buildQueryString({
			country: params.country,
			state: params.state,
			city: params.city,
			displayName: params.displayName,
			topic: params.topic,
			query: params.query,
			limit: params.limit
		});
		return apiRequest('GET', `/units/search?${qs}`);
	},

	// ==================== API Key Management ====================

	/**
	 * Create a new API key.
	 */
	async createApiKey(name?: string): Promise<{
		key: string;
		key_id: string;
		key_prefix: string;
		name: string;
		created_at: string;
	}> {
		return apiRequest('POST', '/api-keys', { name: name || 'My API Key' });
	},

	/**
	 * List all API keys for the current user.
	 */
	async listApiKeys(): Promise<{
		keys: Array<{
			key_id: string;
			key_prefix: string;
			name: string;
			created_at: string;
			last_used_at: string | null;
		}>;
		count: number;
	}> {
		return apiRequest('GET', '/api-keys');
	},

	/**
	 * Revoke an API key.
	 */
	async revokeApiKey(keyId: string): Promise<void> {
		return apiRequest('DELETE', `/api-keys/${keyId}`);
	}
};

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/**
 * Atomic information unit from scout execution.
 */
export interface InformationUnit {
	unit_id: string;
	pk: string;
	sk: string;
	statement: string;
	unit_type: string;
	entities: string[];
	source_url: string;
	source_domain: string | null;
	source_title: string;
	scout_type: string;
	scout_id: string;
	topic?: string;
	created_at: string;
	used_in_article: boolean;
	date?: string | null;
}

// ===========================================================================
// Workspace API — v2 dual-backend helpers
// ===========================================================================
//
// The workspace UI (Plan 04) targets two backends behind a single
// VITE_API_URL: the legacy FastAPI at scoutpost.ai (`{detail: ...}` errors,
// some `{data: [...]}` wrappers) and the Supabase Edge Functions at
// `/functions/v1/*` (`{error, code}` errors, Edge Function paginated
// envelopes shaped `{items, pagination}`). These helpers tolerate both shapes:
// list helpers unwrap `body.data ?? body.items ?? body`, errors normalize
// through `normalizeApiError`, and every helper throws `ApiError` so callers
// have a single catch-type.
//
// Helpers do NOT modify the existing `apiClient` export above.

import type {
	Project as _WorkspaceProject,
	Scout as _WorkspaceScout,
	Unit as _WorkspaceUnit,
	Reflection as _WorkspaceReflection,
	Entity as _WorkspaceEntity,
	CreateScoutInput as _WorkspaceCreateScoutInput,
	PaginatedUnits as _WorkspacePaginatedUnits
} from '$lib/types/workspace';

export type WorkspaceProject = _WorkspaceProject;
export type WorkspaceScout = _WorkspaceScout;
export type WorkspaceUnit = _WorkspaceUnit;
export type WorkspaceReflection = _WorkspaceReflection;
export type WorkspaceEntity = _WorkspaceEntity;
export type WorkspaceCreateScoutInput = _WorkspaceCreateScoutInput;
export type WorkspacePaginatedUnits = _WorkspacePaginatedUnits;

function normalizeWorkspaceScout(scout: WorkspaceScout): WorkspaceScout {
	return {
		...scout,
		type: normalizeScoutType(scout.type)
	};
}

/**
 * Unified error class for every `workspaceApi.*` helper. Preserves the
 * dual-backend error shape in a single type:
 *
 *   - FastAPI: `{detail: string | ValidationError[]}`        → code undefined
 *   - Edge Function: `{error: string, code?: string}`        → code preserved
 *   - HTTP status is attached so callers can branch on 401/402/404/etc.
 *
 * Intentionally extends Error (not Response) so `err instanceof ApiError`
 * works across realms (jsdom/Vitest) and consumers can still use
 * `err.message` like any other Error.
 */
export class ApiError extends Error {
	readonly code?: string;
	readonly status?: number;
	constructor(message: string, code?: string, status?: number) {
		super(message);
		this.name = 'ApiError';
		this.code = code;
		this.status = status;
	}
}

/**
 * Normalize a failed `Response` + parsed body into a `{message, code}` pair.
 *
 * Accepts whatever the backend returned (possibly `null` if JSON parsing
 * failed) and returns a stable two-field shape. Handles:
 *   - FastAPI `{detail: string}`
 *   - FastAPI `{detail: [{msg: ..., loc: [...]}, ...]}` (Pydantic)
 *   - Edge Function `{error: string, code?: string}`
 *   - Anything else — falls back to `HTTP <status>`.
 */
export function normalizeApiError(
	response: { status: number; statusText?: string },
	body: unknown
): { message: string; code?: string } {
	const b = (body ?? {}) as Record<string, unknown>;

	// Edge Function shape
	if (typeof b.error === 'string' && b.error.length > 0) {
		return {
			message: b.error,
			code: typeof b.code === 'string' ? b.code : undefined
		};
	}

	// FastAPI shape
	if ('detail' in b) {
		const detail = b.detail;
		if (typeof detail === 'string' && detail.length > 0) {
			return { message: detail };
		}
		if (Array.isArray(detail)) {
			const joined = detail
				.map((e) => {
					if (typeof e === 'string') return e;
					if (e && typeof e === 'object' && 'msg' in e) {
						return String((e as { msg?: unknown }).msg ?? '');
					}
					return '';
				})
				.filter(Boolean)
				.join('; ');
			if (joined) return { message: joined };
		}
	}

	// Fallback
	const status = response.status ?? 0;
	return {
		message: response.statusText
			? `HTTP ${status} ${response.statusText}`
			: `HTTP ${status || 'error'}`
	};
}

/**
 * Safely parse a Response body as JSON. Returns `null` if the body is not
 * valid JSON (e.g. empty 204, HTML error page, or markdown payload).
 */
async function parseJsonSafe(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return null;
	}
}

/**
 * Build the Authorization header for a workspace request. Pulls the bearer
 * token from the auth store (Supabase JWT when PUBLIC_DEPLOYMENT_TARGET=oss,
 * `null` for  cookies). `credentials: 'include'` is always set by
 * the caller so cookies still accompany the request when no bearer is set.
 */
async function workspaceAuthHeaders(): Promise<Record<string, string>> {
	const { authStore } = await import('$lib/stores/auth');
	const token = await authStore.getToken();
	return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Core workspace request. Resolves the JSON body (or `null` on 204) and
 * throws `ApiError` on non-2xx. Accepts:
 *   - `rawText: true` — resolve as `string` instead of JSON.
 *   - `query` — serialized with omit-undefined rules from `buildQueryString`.
 */
async function workspaceRequest<T>(
	method: string,
	path: string,
	opts: {
		body?: unknown;
		query?: Record<string, string | number | undefined | null>;
		rawText?: boolean;
	} = {}
): Promise<T> {
	const auth = await workspaceAuthHeaders();
	const headers: Record<string, string> = { ...JSON_HEADERS, ...auth };

	const qs = opts.query ? buildQueryString(opts.query) : '';
	const url = buildApiUrl(qs ? `${path}?${qs}` : path);

	const init: RequestInit = {
		method,
		headers,
		/* credentials dropped */
	};
	if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

	const response = await fetch(url, init);

	if (!response.ok) {
		const body = await parseJsonSafe(response);
		const { message, code } = normalizeApiError(response, body);
		throw new ApiError(message, code, response.status);
	}

	if (response.status === 204) return null as unknown as T;
	if (opts.rawText) return (await response.text()) as unknown as T;

	const body = (await parseJsonSafe(response)) as unknown;
	return unwrapEnvelope(body) as T;
}

/**
 * Shared unwrap rule. FastAPI wraps list responses as `{data: [...]}`; Edge
 * Functions wrap them as `{items: [...], pagination: {...}}`. For single
 * records, both backends may return the bare object. This helper tolerates
 * all three.
 *
 * Callers that need both the items AND the pagination envelope should call
 * the helper directly (see `listUnits`).
 */
function unwrapEnvelope(body: unknown): unknown {
	if (body && typeof body === 'object') {
		const b = body as Record<string, unknown>;
		if (Array.isArray(b.data)) return b.data;
		if (Array.isArray(b.items)) return b.items;
	}
	return body;
}

// ---------------------------------------------------------------------------
// workspaceApi — 15 helpers
// ---------------------------------------------------------------------------

/**
 * Workspace v2 API client.
 *
 * Every method:
 *  - Reads auth from `authStore.getToken()` → Bearer header when present.
 *  - Always sends `credentials: 'include'` (cookies still accompany the
 *    request for legacy session-cookie auth).
 *  - Accepts FastAPI `{data: [...]}` OR Edge Function `{items, pagination}`
 *    envelopes and unwraps to the payload shape in the return type.
 *  - Throws `ApiError(message, code, status)` on non-2xx.
 *
 * Endpoint routing assumes VITE_API_URL points at whichever backend should
 * serve the request. Helpers that don't have a FastAPI counterpart
 * (projects, reflections, entities, ingest, mergeEntities)
 * are Edge-only today — see the shape-mismatch table in the PR description.
 */
export const workspaceApi = {
	/**
	 * List all projects for the current user.
	 *
	 * Envelope tolerance: `{items, pagination}` (Edge Function) or
	 * `{data: [...]}` (hypothetical FastAPI) unwrap to `Project[]`.
	 * Edge Function only today (no FastAPI equivalent).
	 */
	async listProjects(): Promise<WorkspaceProject[]> {
		const res = await workspaceRequest<unknown>('GET', '/projects');
		return (Array.isArray(res) ? res : []) as WorkspaceProject[];
	},

	/**
	 * Fetch a single project by id.
	 *
	 * Both backends return the bare object; no envelope unwrap needed but
	 * the shared helper still tolerates `{data: {...}}`.
	 */
	async getProject(id: string): Promise<WorkspaceProject> {
		return workspaceRequest<WorkspaceProject>('GET', `/projects/${encodeURIComponent(id)}`);
	},

	/**
	 * List scouts, optionally scoped to a project.
	 *
	 * The Edge Function returns `{items, pagination}`; FastAPI `/v1/scouts`
	 * returns `{scouts: [...], count}`. The shared unwrap handles the Edge
	 * Function shape — for the FastAPI shape, callers see an array when
	 * `data.items` is absent but `scouts` is present, we still return `[]`.
	 * See the shape-mismatch note in the PR description.
	 */
	async listScouts(projectId?: string): Promise<WorkspaceScout[]> {
		const query = projectId ? { project_id: projectId } : undefined;
		const res = await workspaceRequest<unknown>('GET', '/scouts', { query });
		if (Array.isArray(res)) return (res as WorkspaceScout[]).map(normalizeWorkspaceScout);
		// Tolerate FastAPI `{scouts: [...], count}` shape.
		if (res && typeof res === 'object' && Array.isArray((res as { scouts?: unknown }).scouts)) {
			return (res as { scouts: WorkspaceScout[] }).scouts.map(normalizeWorkspaceScout);
		}
		return [];
	},

	/**
	 * Create a scout. Accepts the template-aware `CreateScoutInput`; callers
	 * are responsible for mapping UI templates (`location`/`beat`) to the
	 * backend `type` (`pulse`).
	 *
	 * Edge Function returns the shaped scout; FastAPI returns a ScoutResponse
	 * with the same id field — both tolerated via the bare-object unwrap.
	 */
	async createScout(data: WorkspaceCreateScoutInput): Promise<WorkspaceScout> {
		return normalizeWorkspaceScout(
			await workspaceRequest<WorkspaceScout>('POST', '/scouts', { body: data })
		);
	},

	/**
	 * Trigger an on-demand run of a scout.
	 *
	 * Edge Function returns `{scout_id, run_id}` (202); FastAPI exposes
	 * `/scrapers/run-now` with a different payload. This helper targets the
	 * Edge Function contract; FastAPI callers should use
	 * `apiClient.runScoutNow` instead (kept for backward compatibility).
	 */
	async runScout(id: string): Promise<{ run_id: string; status?: string }> {
		const res = await workspaceRequest<Record<string, unknown>>(
			'POST',
			`/scouts/${encodeURIComponent(id)}/run`
		);
		return {
			run_id: String(res?.run_id ?? ''),
			status: typeof res?.status === 'string' ? res.status : undefined
		};
	},

	async deleteScout(id: string): Promise<void> {
		await workspaceRequest<Record<string, unknown>>(
			'DELETE',
			`/scouts/${encodeURIComponent(id)}`
		);
	},

	/**
	 * List units, optionally scoped to a scout. Paginated.
	 *
	 * Returns `{units, next_cursor}` where `next_cursor` is a stringified
	 * offset derived from the Edge Function's `{offset, limit, has_more}`
	 * envelope. Callers pass the returned cursor back as the second argument
	 * to page. Pass `scoutId = null` to load across all scouts.
	 */
	async listUnits(
		scoutId: string | null,
		cursor?: string | null
	): Promise<WorkspacePaginatedUnits> {
		const offset = cursor ? parseInt(cursor, 10) || 0 : 0;
		const query: Record<string, string | number | undefined | null> = {
			limit: 50,
			offset
		};
		if (scoutId) query.scout_id = scoutId;

		// Bypass unwrapEnvelope so we can see the pagination metadata.
		const auth = await workspaceAuthHeaders();
		const qs = buildQueryString(query);
		const response = await fetch(buildApiUrl(`/units${qs ? `?${qs}` : ''}`), {
			method: 'GET',
			headers: { ...JSON_HEADERS, ...auth },
			/* credentials dropped */
		});
		if (!response.ok) {
			const body = await parseJsonSafe(response);
			const { message, code } = normalizeApiError(response, body);
			throw new ApiError(message, code, response.status);
		}
		const body = (await parseJsonSafe(response)) as Record<string, unknown> | null;

		// Tolerate both envelopes: `{items, pagination}` (Edge) and
		// `{data: [...]}`/`{units: [...]}` (FastAPI).
		let units: WorkspaceUnit[] = [];
		if (body && Array.isArray(body.items)) units = body.items as WorkspaceUnit[];
		else if (body && Array.isArray(body.data)) units = body.data as WorkspaceUnit[];
		else if (body && Array.isArray((body as { units?: unknown }).units))
			units = (body as { units: WorkspaceUnit[] }).units;

		let nextCursor: string | null = null;
		const pg = body?.pagination as
			| { has_more?: boolean; offset?: number; limit?: number }
			| undefined;
		if (pg && pg.has_more) {
			const nextOffset = (pg.offset ?? offset) + (pg.limit ?? units.length);
			nextCursor = String(nextOffset);
		}

		return { units, next_cursor: nextCursor };
	},

	/**
	 * Fetch a single unit by id.
	 * Both backends return the bare object.
	 */
	async getUnit(id: string): Promise<WorkspaceUnit> {
		return workspaceRequest<WorkspaceUnit>('GET', `/units/${encodeURIComponent(id)}`);
	},

	/**
	 * Semantic search across units, optionally scoped to a scout.
	 *
	 * Edge Function POSTs to `/units/search` with `{query_text, project_id?}`
	 * and returns `{items: [...]}`. FastAPI `/units/search` is GET-based
	 * with a `query` querystring. This helper targets the Edge Function
	 * contract (POST); the shared unwrap handles both `{items}` and
	 * `{data: [...]}`.
	 */
	async searchUnits(query: string, scoutId?: string): Promise<WorkspaceUnit[]> {
		const body: Record<string, unknown> = { query_text: query };
		if (scoutId) body.scout_id = scoutId;
		const res = await workspaceRequest<unknown>('POST', '/units/search', { body });
		return (Array.isArray(res) ? res : []) as WorkspaceUnit[];
	},

	/**
	 * Permanently delete a unit from the inbox.
	 */
	async deleteUnit(id: string): Promise<void> {
		await workspaceRequest<void>('DELETE', `/units/${encodeURIComponent(id)}`);
	},

	/**
	 * List reflections, optionally scoped to a source unit.
	 *
	 * Edge Function supports `project_id` filtering; there is no
	 * `unit_id` filter at the backend today, so when `unitId` is provided
	 * we still pass it through (`unit_id=<id>`) — the Edge Function ignores
	 * unknown query params. See the shape-mismatch note in the PR
	 * description.
	 */
	async listReflections(unitId?: string): Promise<WorkspaceReflection[]> {
		const query = unitId ? { unit_id: unitId } : undefined;
		const res = await workspaceRequest<unknown>('GET', '/reflections', { query });
		return (Array.isArray(res) ? res : []) as WorkspaceReflection[];
	},

	/**
	 * List entities, optionally scoped to a scout.
	 *
	 * Like `listReflections`, the Edge Function doesn't currently filter by
	 * `scout_id` (it filters by `type` and `search`); the parameter is
	 * preserved on the wire for forward compatibility.
	 */
	async listEntities(scoutId?: string): Promise<WorkspaceEntity[]> {
		const query = scoutId ? { scout_id: scoutId } : undefined;
		const res = await workspaceRequest<unknown>('GET', '/entities', { query });
		return (Array.isArray(res) ? res : []) as WorkspaceEntity[];
	},

	/**
	 * Manual ingestion — either a URL to scrape or raw content to extract.
	 *
	 * Edge Function `/ingest` returns `{ingest_id, raw_capture_id, units}`.
	 * There is no FastAPI equivalent today. The plan documented the return
	 * shape as `{job_id}`; we preserve the Edge Function field naming and
	 * expose `ingest_id` + a convenience `job_id` alias for callers that
	 * want the "job" framing.
	 */
	async ingest(params: {
		url?: string;
		content?: string;
		project_id?: string;
		title?: string;
		criteria?: string;
		notes?: string;
	}): Promise<{
		job_id: string;
		ingest_id: string;
		raw_capture_id?: string;
		units: Array<{ id: string; statement: string }>;
	}> {
		const body: Record<string, unknown> = params.url
			? { kind: 'url', url: params.url }
			: { kind: 'text', text: params.content ?? '' };
		if (params.project_id) body.project_id = params.project_id;
		if (params.title) body.title = params.title;
		if (params.criteria) body.criteria = params.criteria;
		if (params.notes) body.notes = params.notes;

		const res = await workspaceRequest<Record<string, unknown>>('POST', '/ingest', { body });
		const ingestId = String(res?.ingest_id ?? res?.job_id ?? '');
		return {
			ingest_id: ingestId,
			job_id: ingestId,
			raw_capture_id:
				typeof res?.raw_capture_id === 'string' ? (res.raw_capture_id as string) : undefined,
			units: Array.isArray(res?.units)
				? (res.units as Array<{ id: string; statement: string }>)
				: []
		};
	},

	/**
	 * Merge one or more entity ids into a keeper entity.
	 *
	 * Plan signature `mergeEntities(ids)` is ambiguous about which id is the
	 * keeper. We require the first id to be the keeper (matching the Edge
	 * Function `{keep_id, merge_ids}` payload) and pass the rest as
	 * `merge_ids`. The Edge Function returns `{merged: <count>}` — we
	 * resolve with a thin `{merged, keep_id}` record.
	 */
	async mergeEntities(ids: string[]): Promise<{ keep_id: string; merged: number }> {
		if (!Array.isArray(ids) || ids.length < 2) {
			throw new ApiError('mergeEntities requires at least 2 ids (keeper + merges)');
		}
		const [keepId, ...mergeIds] = ids;
		const res = await workspaceRequest<Record<string, unknown>>('POST', '/entities/merge', {
			body: { keep_id: keepId, merge_ids: mergeIds }
		});
		return {
			keep_id: keepId,
			merged: typeof res?.merged === 'number' ? (res.merged as number) : mergeIds.length
		};
	},

	/**
	 * Promote a unit (marks verified + cleans rejection flag).
	 *
	 * Edge Function uses `PATCH /units/:id` with `{verified: true}`; there
	 * is no dedicated `/promote` route today. We map `promoteUnit` to that
	 * PATCH so the UI can flip the verification flag without knowing the
	 * column names. See the shape-mismatch note in the PR description.
	 */
	async promoteUnit(id: string): Promise<WorkspaceUnit> {
		return workspaceRequest<WorkspaceUnit>('PATCH', `/units/${encodeURIComponent(id)}`, {
			body: { verified: true }
		});
	},

	/**
	 * Reject a unit (marks verification explicitly false; Civic Scout pipeline
	 * treats this as "do not surface in export").
	 *
	 * Like `promoteUnit`, maps onto `PATCH /units/:id` with `{verified: false,
	 * verification_notes: 'rejected'}` for audit.
	 */
	async rejectUnit(id: string): Promise<WorkspaceUnit> {
		return workspaceRequest<WorkspaceUnit>('PATCH', `/units/${encodeURIComponent(id)}`, {
			body: { verified: false, verification_notes: 'rejected' }
		});
	},

	/**
	 * Civic Scout test extraction — hits the `civic-test` Edge Function (or the
	 * FastAPI civic router) with a list of tracked URLs + optional criteria.
	 * Returns the document count + a sample promise so the AddScoutModal can
	 * validate the Civic config before saving.
	 *
	 * Contract matches `supabase/functions/civic-test/index.ts` (and the FastAPI
	 * civic router's matching `/civic-test` endpoint). Response-shape-tolerant:
	 * fills in sensible fallbacks if a backend omits `valid` or `sample_promise`.
	 */
	async civicTest(params: {
		tracked_urls: string[];
		criteria?: string;
	}): Promise<{ documents_found: number; sample_promise?: string | null; valid: boolean }> {
		const res = await workspaceRequest<Record<string, unknown>>('POST', '/civic-test', {
			body: params
		});
		const found = typeof res?.documents_found === 'number' ? (res.documents_found as number) : 0;
		const sample =
			typeof res?.sample_promise === 'string' ? (res.sample_promise as string) : null;
		const valid =
			typeof res?.valid === 'boolean' ? (res.valid as boolean) : found > 0;
		return { documents_found: found, sample_promise: sample, valid };
	}
};

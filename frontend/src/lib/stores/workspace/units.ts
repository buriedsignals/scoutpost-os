/**
 * Workspace units store — paginated inbox of information units with search.
 *
 * Consumed by: `routes/+page.svelte`.
 *
 * Writeable shape is `{units, cursor, loading, loadingMore, searchQuery,
 * hasMore, error, scoutId}`. Cursor-based pagination: `load(scoutId)` resets
 * the cursor; `loadMore()` appends the next page. `search(q)` switches the
 * list into search mode (cursor/hasMore frozen off) and is a one-shot fetch
 * — calling `load()` returns to paginated mode.
 */
import { writable, type Writable } from 'svelte/store';
import * as m from '$lib/paraglide/messages';
import { getLocale } from '$lib/paraglide/runtime';
import {
	workspaceApi as defaultApi,
	ApiError,
	type WorkspaceUnit,
	type WorkspacePaginatedUnits
} from '$lib/api-client';
import {
	DEMO_UNITS,
	demoDismissed,
	isDemoId,
	isDemoUnit,
	shouldUseLocalDemoUnits
} from '$lib/demo/seed';
import { IS_LOCAL_DEMO_MODE } from '$lib/demo/state';

export interface UnitsState {
	units: WorkspaceUnit[];
	cursor: string | null;
	loading: boolean;
	loadingMore: boolean;
	searchQuery: string;
	hasMore: boolean;
	error: string | null;
	/** Scope of the current listing — null means "all scouts". */
	scoutId: string | null;
}

export interface UnitsApi {
	listUnits: (
		scoutId: string | null,
		cursor?: string | null
	) => Promise<WorkspacePaginatedUnits>;
	searchUnits: (query: string, scoutId?: string) => Promise<WorkspaceUnit[]>;
}

const initialState: UnitsState = {
	units: [],
	cursor: null,
	loading: false,
	loadingMore: false,
	searchQuery: '',
	hasMore: false,
	error: null,
	scoutId: null
};

function errorMessage(e: unknown): string {
	if (e instanceof ApiError) return e.message;
	if (e instanceof Error) return e.message;
	return String(e);
}

type SearchKeywordField = NonNullable<WorkspaceUnit['search_match']>['keyword_fields'][number];

function normalizeForSearch(value: string | null | undefined): string {
	return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function includesQuery(value: string | null | undefined, query: string): boolean {
	return normalizeForSearch(value).includes(query);
}

function demoSearchReason(fields: SearchKeywordField[]): string {
	const labels: Record<SearchKeywordField, string> = {
		statement: m.unit_statement(),
		context_excerpt: m.unit_context(),
		source: m.unit_sourceMetadata(),
		entities: m.workspace_unitDrawer_tabEntities(),
		scout_name: m.scout_name(),
		linked_scouts: m.unit_linkedScouts(),
		tags: m.unit_tags()
	};
	const present = [...new Set(fields)].map((field) => labels[field]);
	if (present.length === 0) return m.unit_directMatch();
	return m.unit_directMatchFields({ fields: new Intl.ListFormat(getLocale(), { type: 'conjunction' }).format(present) });
}

function annotateDemoSearchMatch(unit: WorkspaceUnit, loweredQuery: string): WorkspaceUnit {
	const keywordFields: SearchKeywordField[] = [];

	if (includesQuery(unit.statement, loweredQuery)) keywordFields.push('statement');
	if (includesQuery(unit.context_excerpt, loweredQuery)) keywordFields.push('context_excerpt');
	if (
		includesQuery(unit.source?.title, loweredQuery) ||
		includesQuery(unit.source?.domain, loweredQuery) ||
		includesQuery(unit.source?.url, loweredQuery)
	) {
		keywordFields.push('source');
	}
	if (includesQuery(unit.scout_name, loweredQuery)) keywordFields.push('scout_name');
	if ((unit.entities ?? []).some((entity) => includesQuery(entity.mention_text, loweredQuery))) {
		keywordFields.push('entities');
	}
	if ((unit.tags ?? []).some((tag) => includesQuery(tag, loweredQuery))) {
		keywordFields.push('tags');
	}

	return {
		...unit,
		search_match: {
			category: 'direct',
			reason: demoSearchReason(keywordFields),
			keyword_fields: keywordFields,
			semantic_similarity: null,
			below_interest_threshold: false
		}
	};
}

/**
 * Factory that builds a fresh units store wired to the given api-client
 * surface. Exposed for tests.
 */
export function createUnitsStore(api: UnitsApi = defaultApi as unknown as UnitsApi) {
	const { subscribe, update }: Writable<UnitsState> = writable({ ...initialState });

	/**
	 * Read the current state without subscribing long-term. Internal helper
	 * used by `loadMore` to know which scout id / cursor to request next.
	 */
	function snapshot(): UnitsState {
		let s: UnitsState = { ...initialState };
		const unsub = subscribe((v) => {
			s = v;
		});
		unsub();
		return s;
	}

	function searchDemoUnits(query: string, scoutId: string | null): WorkspaceUnit[] {
		const haystack = (value: WorkspaceUnit): string => [
			value.statement,
			value.context_excerpt,
			value.source?.title,
			value.source?.domain,
			value.source?.url,
			value.scout_name,
			...(value.entities ?? []).map((entity) => entity.mention_text),
			...(value.tags ?? [])
		]
			.filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
			.join(' ')
			.toLowerCase();

		const lowered = query.trim().toLowerCase();
		return DEMO_UNITS
			.filter((unit) => !scoutId || unit.scout_id === scoutId)
			.filter((unit) => haystack(unit).includes(lowered))
			.map((unit) => annotateDemoSearchMatch(unit, lowered));
	}

	return {
		subscribe,

		/**
		 * Load the first page of units for the given scout (or all scouts when
		 * `scoutId` is null). Replaces existing units. Clears searchQuery.
		 */
		async load(scoutId: string | null): Promise<void> {
			if (IS_LOCAL_DEMO_MODE && scoutId === null) {
				update((s) => ({
					...s,
					loading: false,
					error: null,
					searchQuery: '',
					scoutId: null,
					units: demoDismissed() ? [] : [...DEMO_UNITS],
					cursor: null,
					hasMore: false
				}));
				return;
			}
			// Demo-scoped load: serve in-memory demo units without hitting the API.
			if (scoutId && isDemoId(scoutId) && !demoDismissed()) {
				update((s) => ({
					...s,
					loading: false,
					error: null,
					searchQuery: '',
					scoutId,
					units: DEMO_UNITS.filter((u) => u.scout_id === scoutId),
					cursor: null,
					hasMore: false
				}));
				return;
			}
			update((s) => ({
				...s,
				loading: true,
				error: null,
				searchQuery: '',
				scoutId,
				units: [],
				cursor: null,
				hasMore: false
			}));
			try {
				const page = await api.listUnits(scoutId, null);
				update((s) => ({
					...s,
					loading: false,
					units: page.units,
					cursor: page.next_cursor,
					hasMore: page.next_cursor !== null
				}));
			} catch (e) {
				update((s) => ({ ...s, loading: false, error: errorMessage(e) }));
			}
		},

		/**
		 * Fetch the next page and append to the current units list. No-ops if
		 * `hasMore` is false, a fetch is already in flight, or we're in
		 * search mode.
		 */
		async loadMore(): Promise<void> {
			const current = snapshot();
			if (!current.hasMore || current.loading || current.loadingMore) return;
			if (current.searchQuery) return;

			update((s) => ({ ...s, loadingMore: true, error: null }));
			try {
				const page = await api.listUnits(current.scoutId, current.cursor);
				update((s) => ({
					...s,
					loadingMore: false,
					units: [...s.units, ...page.units],
					cursor: page.next_cursor,
					hasMore: page.next_cursor !== null
				}));
			} catch (e) {
				update((s) => ({ ...s, loadingMore: false, error: errorMessage(e) }));
			}
		},

		/**
		 * Enter search mode. Empty-string query exits search mode and reloads
		 * the current scout's inbox page (so the caller doesn't have to chain
		 * a separate `load()` from the debounce handler).
		 */
		async search(query: string, scoutId?: string | null): Promise<void> {
			const trimmed = query.trim();
			const current = snapshot();
			const scope = scoutId === undefined ? current.scoutId : scoutId;
			if (trimmed === '') {
				// Exit search mode and reload.
				update((s) => ({ ...s, searchQuery: '', error: null }));
				await this.load(scope ?? null);
				return;
			}

			const localDemoScope = shouldUseLocalDemoUnits({
				scopeScoutId: scope ?? null,
				units: current.units
			});

			if (localDemoScope) {
				update((s) => ({
					...s,
					searchQuery: trimmed,
					loading: false,
					error: null,
					cursor: null,
					hasMore: false,
					scoutId: scope ?? null,
					units: searchDemoUnits(trimmed, scope ?? null)
				}));
				return;
			}

			update((s) => ({
				...s,
				searchQuery: trimmed,
				loading: true,
				error: null,
				cursor: null,
				hasMore: false,
				scoutId: scope ?? null
			}));
			try {
				const units = await api.searchUnits(trimmed, scope ?? undefined);
				update((s) => ({ ...s, loading: false, units }));
			} catch (e) {
				update((s) => ({ ...s, loading: false, error: errorMessage(e) }));
			}
		},

		/**
		 * Patch a single unit in place. Used after verify/reject mutations so the
		 * verification state flips in the feed without a full re-fetch.
		 */
		patchUnit(id: string, patch: Partial<WorkspaceUnit>): void {
			update((s) => ({
				...s,
				units: s.units.map((u) => (u.id === id ? { ...u, ...patch } : u))
			}));
		},

		/**
		 * Remove a single unit from the list (e.g. rejected units on needs-review
		 * filter should disappear immediately).
		 */
		removeUnit(id: string): void {
			update((s) => ({
				...s,
				units: s.units.filter((u) => u.id !== id)
			}));
		},

		/**
		 * Reset the inbox to the full demo seed (all 12 units, scope = null).
		 * No-op if the user has already dismissed the demo. Safe to call from
		 * both the initial mount (empty inbox) and from handleBackToAll after
		 * the user peeked into a demo scout.
		 */
		seedDemo(): void {
			if (demoDismissed()) return;
			update((s) => ({
				...s,
				loading: false,
				error: null,
				searchQuery: '',
				scoutId: null,
				units: [...DEMO_UNITS],
				cursor: null,
				hasMore: false
			}));
		},

		/**
		 * Drop any demo-prefixed units from state. Safe to call any time.
		 */
		clearDemo(): void {
			update((s) => ({
				...s,
				units: s.units.filter((u) => !isDemoUnit(u))
			}));
		},

		/**
		 * Synchronously read the current state. Test-only.
		 */
		getState(): UnitsState {
			return snapshot();
		}
	};
}

export const unitsStore = createUnitsStore();

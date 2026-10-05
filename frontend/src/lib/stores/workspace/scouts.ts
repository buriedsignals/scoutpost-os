/**
 * Workspace scouts store — paginated list plus optimistic remove with
 * rollback on error.
 *
 * Consumed by: `routes/+page.svelte`.
 *
 * Writeable shape is `{scouts, loading, error}`. The api-client is an
 * injectable dependency so tests can stub without touching
 * `$lib/api-client` / `$lib/stores/auth`.
 */
import { writable, type Writable } from 'svelte/store';
import {
	workspaceApi as defaultApi,
	ApiError,
	type WorkspaceScout,
	type WorkspacePaginatedScouts
} from '$lib/api-client';
import { DEMO_SCOUTS, demoDismissed, isDemoScout } from '$lib/demo/seed';
import { IS_LOCAL_DEMO_MODE } from '$lib/demo/state';

export interface ScoutsState {
	scouts: WorkspaceScout[];
	cursor: string | null;
	hasMore: boolean;
	loadingMore: boolean;
	total: number;
	loading: boolean;
	error: string | null;
}

export interface ScoutsApi {
	listScouts: (projectId?: string, cursor?: string | null) => Promise<WorkspacePaginatedScouts>;
	deleteScout?: (id: string) => Promise<void>;
}

const initialState: ScoutsState = {
	scouts: [],
	cursor: null,
	hasMore: false,
	loadingMore: false,
	total: 0,
	loading: false,
	error: null
};

function errorMessage(e: unknown): string {
	if (e instanceof ApiError) return e.message;
	if (e instanceof Error) return e.message;
	return String(e);
}

/**
 * Factory that builds a fresh scouts store wired to the given api-client
 * surface. Exposed for tests.
 */
export function createScoutsStore(api: ScoutsApi = defaultApi as unknown as ScoutsApi) {
	const { subscribe, update }: Writable<ScoutsState> = writable({ ...initialState });

	return {
		subscribe,

		/**
		 * Load scouts for a project (or all scouts when `projectId` is
		 * undefined). Clears error; sets loading true during the fetch.
		 */
		async load(projectId?: string | null): Promise<void> {
			if (IS_LOCAL_DEMO_MODE) {
				update((s) => ({
					...s,
					loading: false,
					error: null,
					scouts: demoDismissed() ? [] : [...DEMO_SCOUTS],
					total: demoDismissed() ? 0 : DEMO_SCOUTS.length,
					cursor: null,
					hasMore: false
				}));
				return;
			}
			update((s) => ({ ...s, loading: true, error: null }));
			try {
				const page = await api.listScouts(projectId ?? undefined);
				update((s) => ({
					...s,
					scouts: page.scouts,
					cursor: page.next_cursor,
					hasMore: page.next_cursor !== null,
					total: page.total,
					loading: false
				}));
			} catch (e) {
				update((s) => ({ ...s, loading: false, error: errorMessage(e) }));
			}
		},

		async loadMore(projectId?: string | null): Promise<void> {
			let current: ScoutsState = { ...initialState };
			const unsubscribe = subscribe((state) => (current = state));
			unsubscribe();
			if (!current.hasMore || current.loading || current.loadingMore) return;

			update((s) => ({ ...s, loadingMore: true, error: null }));
			try {
				const page = await api.listScouts(projectId ?? undefined, current.cursor);
				update((s) => ({
					...s,
					scouts: [
						...s.scouts,
						...page.scouts.filter((scout) => !s.scouts.some((existing) => existing.id === scout.id))
					],
					cursor: page.next_cursor,
					hasMore: page.next_cursor !== null,
					total: page.total,
					loadingMore: false
				}));
			} catch (e) {
				update((s) => ({ ...s, loadingMore: false, error: errorMessage(e) }));
			}
		},

		/**
		 * Remove a scout. Optimistically drops the row; restores it on error.
		 * No-ops (state-only drop) if the injected api lacks `deleteScout`.
		 */
		async remove(id: string): Promise<void> {
			let removed: WorkspaceScout | undefined;
			update((s) => {
				removed = s.scouts.find((x) => x.id === id);
				return {
					...s,
					scouts: s.scouts.filter((x) => x.id !== id),
					total: removed ? Math.max(0, s.total - 1) : s.total,
					error: null
				};
			});

			if (!api.deleteScout) return;
			try {
				await api.deleteScout(id);
			} catch (e) {
				update((s) => ({
					...s,
					scouts: removed ? [removed, ...s.scouts] : s.scouts,
					total: removed ? s.total + 1 : s.total,
					error: errorMessage(e)
				}));
			}
		},

		/**
		 * Inject the 4 demo scouts for brand-new signups. No-op unless the
		 * current list is empty and the user has not already dismissed the
		 * demo (localStorage flag).
		 */
		seedDemo(): void {
			if (demoDismissed()) return;
			update((s) => {
				if (s.scouts.length > 0) return s;
				return { ...s, scouts: [...DEMO_SCOUTS], total: DEMO_SCOUTS.length };
			});
		},

		/**
		 * Drop all demo scouts from state. Safe to call more than once.
		 * The localStorage dismissal flag is the page's responsibility —
		 * callers must `markDemoDismissed()` themselves when appropriate.
		 */
		clearDemo(): void {
			update((s) => ({
				...s,
				scouts: s.scouts.filter((row) => !isDemoScout(row)),
				total: s.scouts.filter((row) => !isDemoScout(row)).length
			}));
		},

		/**
		 * Synchronously read the current state. Test-only.
		 */
		getState(): ScoutsState {
			let snapshot: ScoutsState = { ...initialState };
			const unsub = subscribe((s) => {
				snapshot = s;
			});
			unsub();
			return snapshot;
		}
	};
}

export const scoutsStore = createScoutsStore();

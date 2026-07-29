/**
 * Workspace scouts store — list, create, remove, update with optimistic
 * updates + rollback on error.
 *
 * Consumed by: `components/workspace/ScoutList.svelte`,
 *              `components/workspace/AddScoutModal.svelte` (PR 2).
 *
 * Writeable shape is `{scouts, loading, error}`. All mutator methods accept
 * the api-client as an injectable dependency so tests can stub without
 * touching `$lib/api-client` / `$lib/stores/auth`.
 */
import { writable, type Writable } from 'svelte/store';
import {
	workspaceApi as defaultApi,
	ApiError,
	type WorkspaceScout,
	type WorkspaceCreateScoutInput,
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
	createScout: (data: WorkspaceCreateScoutInput) => Promise<WorkspaceScout>;
	// Optional; not on the exported workspaceApi today — tests pass stubs.
	updateScout?: (id: string, patch: Partial<WorkspaceScout>) => Promise<WorkspaceScout>;
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
	const { subscribe, update, set }: Writable<ScoutsState> = writable({ ...initialState });

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
		 * Create a scout. Optimistically inserts a placeholder row immediately
		 * (id prefixed `tmp-`), swaps it for the server row on success, or
		 * rolls the placeholder out on error.
		 */
		async create(input: WorkspaceCreateScoutInput): Promise<WorkspaceScout | null> {
			const tmpId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			const optimistic: WorkspaceScout = {
				id: tmpId,
				name: input.name,
				type: input.type,
				criteria: input.criteria ?? null,
				topic: input.topic ?? null,
				url: input.url ?? null,
				source_mode: input.source_mode ?? null,
				excluded_domains: input.excluded_domains ?? [],
				priority_sources: input.priority_sources ?? [],
				platform: input.platform ?? null,
				profile_handle: input.profile_handle ?? null,
				monitor_mode: input.monitor_mode ?? null,
				track_removals: input.track_removals ?? false,
				root_domain: input.root_domain ?? null,
				tracked_urls: input.tracked_urls ?? [],
				location: input.location ?? null,
				project_id: input.project_id ?? null,
				regularity: input.regularity ?? null,
				schedule_cron: input.schedule_cron ?? null,
				is_active: false,
				consecutive_failures: 0,
				last_run: null,
				created_at: new Date().toISOString()
			};
			update((s) => ({
				...s,
				scouts: [optimistic, ...s.scouts],
				total: s.total + 1,
				error: null
			}));

			try {
				const created = await api.createScout(input);
				update((s) => ({
					...s,
					scouts: s.scouts.map((row) => (row.id === tmpId ? created : row))
				}));
				return created;
			} catch (e) {
				// Rollback: drop the placeholder.
				update((s) => ({
					...s,
					scouts: s.scouts.filter((row) => row.id !== tmpId),
					total: Math.max(0, s.total - 1),
					error: errorMessage(e)
				}));
				return null;
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
		 * Update a scout field (e.g. rename). Optimistically patches the row;
		 * restores the prior value on error.
		 */
		async update(id: string, patch: Partial<WorkspaceScout>): Promise<void> {
			let prior: WorkspaceScout | undefined;
			update((s) => {
				prior = s.scouts.find((x) => x.id === id);
				return {
					...s,
					scouts: s.scouts.map((row) => (row.id === id ? { ...row, ...patch } : row)),
					error: null
				};
			});

			if (!api.updateScout) return;
			try {
				const fresh = await api.updateScout(id, patch);
				update((s) => ({
					...s,
					scouts: s.scouts.map((row) => (row.id === id ? fresh : row))
				}));
			} catch (e) {
				update((s) => ({
					...s,
					scouts: prior
						? s.scouts.map((row) => (row.id === id ? (prior as WorkspaceScout) : row))
						: s.scouts,
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
		},

		/**
		 * Reset to initial state. Test-only.
		 */
		reset(): void {
			set({ ...initialState, scouts: [] });
		}
	};
}

export const scoutsStore = createScoutsStore();

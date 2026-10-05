/**
 * Tests for the workspace scouts store — load/pagination and optimistic
 * remove with rollback.
 *
 * Uses a stubbed api surface (no fetch / module mocks needed) so tests
 * stay focused on the store's state-transition behaviour.
 */
import { describe, it, expect, vi } from 'vitest';
import type { WorkspaceScout } from '$lib/api-client';
import { createScoutsStore, type ScoutsApi } from '$lib/stores/workspace/scouts';

function row(partial: Partial<WorkspaceScout>): WorkspaceScout {
	return {
		id: 'id-x',
		name: 'Scout',
		type: 'web',
		criteria: null,
		url: null,
		location: null,
		project_id: null,
		regularity: null,
		schedule_cron: null,
		is_active: false,
		consecutive_failures: 0,
		last_run: null,
		created_at: '2026-01-01T00:00:00Z',
		...partial
	};
}

describe('workspace scouts store', () => {
	// ---------------------------------------------------------------------
	// load
	// ---------------------------------------------------------------------

	it('load() populates scouts and clears loading/error', async () => {
		const scouts = [row({ id: 's1', name: 'A' }), row({ id: 's2', name: 'B' })];
		const api = {
			listScouts: vi.fn(async () => ({ scouts, next_cursor: null, total: 2 }))
		};
		const store = createScoutsStore(api as unknown as ScoutsApi);

		const promise = store.load('p1');
		expect(store.getState().loading).toBe(true);
		await promise;

		expect(store.getState().loading).toBe(false);
		expect(store.getState().scouts).toEqual(scouts);
		expect(store.getState().error).toBeNull();
		expect(api.listScouts).toHaveBeenCalledWith('p1');
	});

	it('loadMore() appends a second scout page instead of stopping at 50', async () => {
		const firstPage = Array.from({ length: 50 }, (_, i) => row({ id: `s${i}` }));
		const secondPage = [row({ id: 's50', name: 'Scout 51' })];
		const api = {
			listScouts: vi
				.fn()
				.mockResolvedValueOnce({ scouts: firstPage, next_cursor: '50', total: 51 })
				.mockResolvedValueOnce({ scouts: secondPage, next_cursor: null, total: 51 })
		};
		const store = createScoutsStore(api as unknown as ScoutsApi);

		await store.load();
		expect(store.getState().scouts).toHaveLength(50);
		expect(store.getState().hasMore).toBe(true);

		await store.loadMore();
		expect(api.listScouts).toHaveBeenLastCalledWith(undefined, '50');
		expect(store.getState().scouts).toHaveLength(51);
		expect(store.getState().scouts.at(-1)?.name).toBe('Scout 51');
		expect(store.getState().hasMore).toBe(false);
	});

	it('load() surfaces errors without crashing', async () => {
		const api = {
			listScouts: vi.fn(async () => {
				throw new Error('boom');
			})
		};
		const store = createScoutsStore(api as unknown as ScoutsApi);
		await store.load();
		expect(store.getState().loading).toBe(false);
		expect(store.getState().error).toBe('boom');
		expect(store.getState().scouts).toEqual([]);
	});

	// ---------------------------------------------------------------------
	// remove — optimistic drop + rollback
	// ---------------------------------------------------------------------

	it('remove() drops the row immediately and keeps it dropped on success', async () => {
		const a = row({ id: 'a' });
		const b = row({ id: 'b' });
		const api = {
			listScouts: vi.fn(async () => ({ scouts: [a, b], next_cursor: null, total: 2 })),
			deleteScout: vi.fn(async () => undefined)
		};
		const store = createScoutsStore(api as unknown as ScoutsApi);
		await store.load();
		expect(store.getState().scouts).toHaveLength(2);

		await store.remove('a');
		expect(store.getState().scouts.map((s) => s.id)).toEqual(['b']);
		expect(api.deleteScout).toHaveBeenCalledWith('a');
	});

	it('remove() restores the row on API error', async () => {
		const a = row({ id: 'a' });
		const b = row({ id: 'b' });
		const api = {
			listScouts: vi.fn(async () => ({ scouts: [a, b], next_cursor: null, total: 2 })),
			deleteScout: vi.fn(async () => {
				throw new Error('cannot delete');
			})
		};
		const store = createScoutsStore(api as unknown as ScoutsApi);
		await store.load();
		await store.remove('a');
		// Rollback restores a (at the front per implementation).
		expect(store.getState().scouts.map((s) => s.id).sort()).toEqual(['a', 'b']);
		expect(store.getState().error).toBe('cannot delete');
	});

	it('clearDemo() removes hosted onboarding demo rows as well as local demo ids', async () => {
		const api = {
			listScouts: vi.fn(async () => ({
				scouts: [
					row({ id: 'onboarding-demo', name: 'Seeded demo scout', is_demo: true }),
					row({ id: 'real-1', name: 'Real scout' })
				],
				next_cursor: null,
				total: 2
			}))
		};
		const store = createScoutsStore(api as unknown as ScoutsApi);
		await store.load();

		store.clearDemo();
		expect(store.getState().scouts.map((scout) => scout.id)).toEqual(['real-1']);
	});
});

/**
 * Tests for the workspace scouts store — optimistic update + rollback.
 *
 * Uses a stubbed api surface (no fetch / module mocks needed) so tests
 * stay focused on the store's state-transition behaviour.
 */
import { describe, it, expect, vi } from 'vitest';
import type { WorkspaceScout, WorkspaceCreateScoutInput } from '$lib/api-client';
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
			listScouts: vi.fn(async () => ({ scouts, next_cursor: null, total: 2 })),
			createScout: vi.fn()
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
				.mockResolvedValueOnce({ scouts: secondPage, next_cursor: null, total: 51 }),
			createScout: vi.fn()
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
			}),
			createScout: vi.fn()
		};
		const store = createScoutsStore(api as unknown as ScoutsApi);
		await store.load();
		expect(store.getState().loading).toBe(false);
		expect(store.getState().error).toBe('boom');
		expect(store.getState().scouts).toEqual([]);
	});

	// ---------------------------------------------------------------------
	// create — optimistic insert + server swap
	// ---------------------------------------------------------------------

	it('create() inserts a tmp row immediately, then replaces with server row', async () => {
		const server = row({ id: 'server-1', name: 'Fresh' });
		let resolveCreate: (r: WorkspaceScout) => void = () => {};
		const api = {
			listScouts: vi.fn(),
			createScout: vi.fn(
				() =>
					new Promise<WorkspaceScout>((r) => {
						resolveCreate = r;
					})
			)
		};
		const store = createScoutsStore(api as unknown as ScoutsApi);

		const input: WorkspaceCreateScoutInput = { name: 'Fresh', type: 'web' };
		const pending = store.create(input);

		// Optimistic: tmp row exists with tmp- prefix id.
		const midway = store.getState();
		expect(midway.scouts.length).toBe(1);
		expect(midway.scouts[0].id).toMatch(/^tmp-/);
		expect(midway.scouts[0].name).toBe('Fresh');
		expect(midway.error).toBeNull();

		resolveCreate(server);
		const result = await pending;
		expect(result).toEqual(server);

		const final = store.getState();
		expect(final.scouts.length).toBe(1);
		expect(final.scouts[0]).toEqual(server);
	});

	// ---------------------------------------------------------------------
	// create — rollback on error
	// ---------------------------------------------------------------------

	it('create() rolls back the tmp row on API error and records error message', async () => {
		const api = {
			listScouts: vi.fn(),
			createScout: vi.fn(async () => {
				throw new Error('nope');
			})
		};
		const store = createScoutsStore(api as unknown as ScoutsApi);
		const result = await store.create({ name: 'Fail', type: 'web' });
		expect(result).toBeNull();
		expect(store.getState().scouts).toEqual([]);
		expect(store.getState().error).toBe('nope');
	});

	// ---------------------------------------------------------------------
	// remove — optimistic drop + rollback
	// ---------------------------------------------------------------------

	it('remove() drops the row immediately and keeps it dropped on success', async () => {
		const a = row({ id: 'a' });
		const b = row({ id: 'b' });
		const api = {
			listScouts: vi.fn(async () => ({ scouts: [a, b], next_cursor: null, total: 2 })),
			createScout: vi.fn(),
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
			createScout: vi.fn(),
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

	// ---------------------------------------------------------------------
	// update — optimistic patch + rollback
	// ---------------------------------------------------------------------

	it('update() patches immediately and persists on success', async () => {
		const a = row({ id: 'a', name: 'Old' });
		const server = row({ id: 'a', name: 'New' });
		const api = {
			listScouts: vi.fn(async () => ({ scouts: [a], next_cursor: null, total: 1 })),
			createScout: vi.fn(),
			updateScout: vi.fn(async () => server)
		};
		const store = createScoutsStore(api as unknown as ScoutsApi);
		await store.load();
		await store.update('a', { name: 'New' });
		expect(store.getState().scouts[0]).toEqual(server);
		expect(api.updateScout).toHaveBeenCalledWith('a', { name: 'New' });
	});

	it('update() rolls back to the prior row on error', async () => {
		const a = row({ id: 'a', name: 'Old' });
		const api = {
			listScouts: vi.fn(async () => ({ scouts: [a], next_cursor: null, total: 1 })),
			createScout: vi.fn(),
			updateScout: vi.fn(async () => {
				throw new Error('update failed');
			})
		};
		const store = createScoutsStore(api as unknown as ScoutsApi);
		await store.load();
		await store.update('a', { name: 'New' });
		expect(store.getState().scouts[0].name).toBe('Old');
		expect(store.getState().error).toBe('update failed');
	});

	// ---------------------------------------------------------------------
	// reset
	// ---------------------------------------------------------------------

	it('reset() clears scouts / loading / error', async () => {
		const api = {
			listScouts: vi.fn(async () => ({ scouts: [row({ id: 'x' })], next_cursor: null, total: 1 })),
			createScout: vi.fn()
		};
		const store = createScoutsStore(api as unknown as ScoutsApi);
		await store.load();
		expect(store.getState().scouts.length).toBe(1);
		store.reset();
		expect(store.getState()).toEqual({
			scouts: [],
			cursor: null,
			hasMore: false,
			loadingMore: false,
			total: 0,
			loading: false,
			error: null
		});
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
			})),
			createScout: vi.fn()
		};
		const store = createScoutsStore(api as unknown as ScoutsApi);
		await store.load();

		store.clearDemo();
		expect(store.getState().scouts.map((scout) => scout.id)).toEqual(['real-1']);
	});
});

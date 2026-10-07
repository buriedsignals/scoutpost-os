import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const DEMO_DISMISSED_KEY = 'cojournalist_demo_dismissed';

describe('workspace local demo mode', () => {
	// The first import of this module graph costs about 2 s idle and over 5 s
	// when the full suite runs in parallel, which timed out whichever test came
	// first (and leaked its pending work into the next test). Pay it once here;
	// vi.resetModules() later only re-evaluates the already-transformed modules.
	beforeAll(
		() => Promise.all([import('$lib/stores/workspace/scouts'), import('$lib/stores/workspace/units')]),
		60_000
	);

	beforeEach(() => {
		vi.resetModules();
		vi.unstubAllEnvs();
		localStorage.clear();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		localStorage.clear();
	});

	it('scouts load from the local demo seed without calling the API', async () => {
		vi.stubEnv('PUBLIC_LOCAL_DEMO_MODE', 'true');
		localStorage.setItem(DEMO_DISMISSED_KEY, '1');

		const { createScoutsStore } = await import('$lib/stores/workspace/scouts');
		const api = {
			listScouts: vi.fn(async () => [])
		};
		const store = createScoutsStore(api as never);

		await store.load();

		expect(api.listScouts).not.toHaveBeenCalled();
		expect(store.getState().scouts.length).toBeGreaterThan(0);
	});

	it('units load from the local demo seed without calling the API', async () => {
		vi.stubEnv('PUBLIC_LOCAL_DEMO_MODE', 'true');
		localStorage.setItem(DEMO_DISMISSED_KEY, '1');

		const { createUnitsStore } = await import('$lib/stores/workspace/units');
		const api = {
			listUnits: vi.fn(async () => ({ units: [], next_cursor: null })),
			searchUnits: vi.fn(async () => [])
		};
		const store = createUnitsStore(api as never);

		await store.load(null);

		expect(api.listUnits).not.toHaveBeenCalled();
		expect(store.getState().units.length).toBeGreaterThan(0);
	});
});

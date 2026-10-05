/**
 * Tests for workspace selection + drawer stores — state transitions only
 * (no fetches, no async).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { selectionStore } from '$lib/stores/workspace/selection';
import { drawerStore } from '$lib/stores/workspace/drawer';

describe('workspace selection store', () => {
	beforeEach(() => {
		selectionStore.clear();
	});

	it('selectScout sets scoutId and clears unitId', () => {
		selectionStore.selectUnit('u1');
		expect(selectionStore.getState().unitId).toBe('u1');
		selectionStore.selectScout('s1');
		expect(selectionStore.getState()).toEqual({ scoutId: 's1', unitId: null });
	});

	it('selectUnit toggles without touching scope', () => {
		selectionStore.selectScout('s1');
		selectionStore.selectUnit('u1');
		expect(selectionStore.getState()).toEqual({ scoutId: 's1', unitId: 'u1' });
		selectionStore.selectUnit('u2');
		expect(selectionStore.getState()).toEqual({ scoutId: 's1', unitId: 'u2' });
		selectionStore.selectUnit(null);
		expect(selectionStore.getState()).toEqual({ scoutId: 's1', unitId: null });
	});

	it('clear() resets both ids to null', () => {
		selectionStore.selectScout('s1');
		selectionStore.selectUnit('u1');
		selectionStore.clear();
		expect(selectionStore.getState()).toEqual({ scoutId: null, unitId: null });
	});
});

describe('workspace drawer store', () => {
	beforeEach(() => {
		drawerStore.closeAndClear();
		selectionStore.clear();
	});

	it('closeAndClear() closes AND clears unit selection', () => {
		selectionStore.selectScout('s1');
		selectionStore.selectUnit('u1');
		drawerStore.open();
		expect(drawerStore.getState().open).toBe(true);
		drawerStore.closeAndClear();

		expect(drawerStore.getState().open).toBe(false);
		// scope preserved; unit cleared.
		expect(selectionStore.getState()).toEqual({ scoutId: 's1', unitId: null });
	});
});

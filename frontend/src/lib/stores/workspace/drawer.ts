/**
 * Workspace drawer store — open/closed state for the UnitDrawer slide-over.
 *
 * Kept separate from `selectionStore` so exit animations don't race with
 * selection changes. Calling `closeAndClear()` closes the drawer AND clears
 * the focused unit id so the next open starts from a clean slate (plan 04
 * risk #7).
 *
 * Consumed by: `components/workspace/UnitDrawer.svelte`,
 *              `components/workspace/Inbox.svelte` (PR 2).
 */
import { writable, type Writable } from 'svelte/store';
import { selectionStore } from './selection';

export interface DrawerState {
	open: boolean;
}

const initialState: DrawerState = { open: false };

function createDrawerStore() {
	const { subscribe, set }: Writable<DrawerState> = writable({ ...initialState });

	return {
		subscribe,

		open(): void {
			set({ open: true });
		},

		/**
		 * Close the drawer AND clear the unit selection — avoids stale state on
		 * reopen. See plan 04 risk #7.
		 */
		closeAndClear(): void {
			set({ open: false });
			selectionStore.selectUnit(null);
		},

		/**
		 * Synchronously read the current state. Test-only.
		 */
		getState(): DrawerState {
			let snapshot: DrawerState = { ...initialState };
			const unsub = subscribe((s) => {
				snapshot = s;
			});
			unsub();
			return snapshot;
		}
	};
}

export const drawerStore = createDrawerStore();

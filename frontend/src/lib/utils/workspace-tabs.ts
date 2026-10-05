/**
 * Tab list for the three-way `UnitDrawer.svelte` tab state
 * (content / entities / reflections).
 */

export const DRAWER_TABS = ['content', 'entities', 'reflections'] as const;
export type DrawerTab = (typeof DRAWER_TABS)[number];

export const DEFAULT_TAB: DrawerTab = 'content';

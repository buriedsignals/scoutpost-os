---
title: "feat: Apply the Night Watch visual system to the Scoutpost workspace"
type: feat
status: approved-specification
date: 2026-07-15
delete_after_implementation: true
---

# Scoutpost Night Watch UI refresh specification

## Summary

Apply the approved Night Watch visual direction to the existing Scoutpost workspace without redesigning its layout or changing its product behavior.

The current workspace composition, section order, responsive breakpoints, scout cards, focused-scout state, information-unit inbox, unit drawer, creation panels, menus, and modals must remain in place. This is a visual-system migration plus three approved navigation changes:

1. Center the **New Scout** and **Connect Agent** actions in the top navigation.
2. Rename **Agents** to **Connect Agent** and give it strong, persistent visual emphasis.
3. Remove the redundant **All scouts** selector from the secondary filter bar. Users already select scouts from the scout cards below.

The approved visual reference is the isolated Svelte prototype at:

`design-explorations/night-watch-shadcn-svelte/`

Use that prototype for color, type, surface, radius, hover, focus, and component direction. Do not copy its sidebar, dashboard composition, example content, counts, or information architecture into the production workspace.

The prototype is temporary. After the approved visual system has been transferred to the production frontend and verified, delete the entire `design-explorations/night-watch-shadcn-svelte/` directory. It must not remain as an alternate frontend, reference implementation, or source of duplicate components after this work is complete.

This is a temporary implementation specification. Keep it unstaged during implementation and delete it after the refresh is implemented, visually approved, and the permanent design documentation is updated.

---

## Product decisions

### Preserve the existing layout

The production layout is the source of truth. Preserve:

- the top navigation height and overall shell;
- the secondary filter bar directly below it;
- the scouts section above the inbox in State 1;
- the focused-scout summary above the inbox in State 2;
- the information-unit inbox header, search, filters, rows, pagination, and empty states;
- the unit drawer and all existing scout creation views;
- the current desktop and responsive section ordering;
- existing loading, demo, error, confirmation, disabled, and empty states.

Do not introduce the prototype's left sidebar, monitoring-status rail, metric-card row, greeting hero, or new page regions. Do not remove, merge, or reorder existing product content.

The only permitted structural changes are the centered top-navigation action group and removal of the third secondary-nav selector.

### Preserve State 1 and State 2

The workspace has two core states. Both must remain behaviorally identical to production.

#### State 1 — all-scout workspace

- `selection.scoutId === null`.
- The scouts grid is visible.
- The inbox loads information units across all scouts with `unitsStore.load(null)`.
- Location and topic filters continue to filter the scout cards.
- Clicking a scout enters State 2.

#### State 2 — focused scout

- `selection.scoutId` contains the selected scout ID.
- `ScoutFocus` replaces the scouts grid.
- The same inbox remains below it and loads only units belonging to the selected scout with `unitsStore.load(scout.id)`.
- **Back to all scouts** returns to State 1 and restores the all-scout inbox.
- Deep links using `?scout=<id>` continue to open State 2 and consume the query parameter as they do today.

The information-unit status filter is independent of scout scope and must remain available in both states:

- **Needs review** shows unverified units within the current scope.
- **All** shows all units within the current scope.
- Search remains scoped to the current all-scout or focused-scout inbox.
- Verifying, rejecting, deleting, or opening a unit must behave exactly as it does before the refresh.

### Connect Agent is a primary product action

Use the label **Connect Agent** in the top navigation. This is clearer and more actionable than the noun-only **Agents** label.

The button must remain visible at all normal desktop widths and should have comparable prominence to **New Scout**, while remaining visually distinguishable:

- **New Scout:** warm moon/amber primary action.
- **Connect Agent:** cool pond/steel-teal action with a clear bot or connection icon.

Clicking **Connect Agent** must preserve the current behavior:

- set `agentsApiOnly = false`;
- open `AgentsModal`;
- show the modal's existing agents view;
- preserve the separate user-menu **API** action and its `apiOnly` behavior.

Do not add a nag, pulse animation, notification badge, forced modal, or dismissible promotional treatment. The incentive comes from placement, wording, contrast, and an immediately understandable icon.

---

## Visual thesis

Moonlight reflecting on a dark pond: friendly graphite surfaces, subtle cool blue-green depth, clear cream-white typography, rounded controls, and restrained warm light for the main creation action.

The interface should feel like a modern monitoring instrument without looking militarized, cyberpunk, or generically AI-generated.

## Content plan

Keep every existing product region and its copy in the same order. Restyle the existing shell and components in place. The only copy change in this scope is **Agents** → **Connect Agent** in the top navigation; documentation copy that instructs users to click the button must be updated accordingly.

## Interaction plan

- Navigation and buttons receive a small luminance change and soft shadow/lift on hover.
- Scout cards and information-unit rows receive a subtle moonlit surface reveal without moving content.
- Source links may use the approved shadcn-svelte Hover Card to preview source metadata without changing row height or click behavior.

All motion must honor `prefers-reduced-motion`.

---

## Visual system

### Typography

Use no more than two families in the authenticated product workspace:

- **UI, headings, buttons, and body:** Manrope, weights 500, 600, and 700.
- **Technical metadata, timestamps, IDs, and compact labels:** IBM Plex Mono, weights 400, 500, and 600.

Requirements:

- Replace Crimson Pro, Inter, Geist, and JetBrains Mono in the workspace visual layer.
- Use Manrope at weight 500 for normal UI text so secondary labels do not feel thin.
- Use 600 for navigation, card titles, and important controls.
- Use 700 sparingly for strong counts or page-level emphasis.
- Do not introduce serif headings into the refreshed workspace.
- Preserve the existing typographic sizes and content hierarchy unless a font-metric adjustment is necessary to prevent clipping.

### Core tokens

Map the approved prototype values into the production token names in `frontend/src/app.css`. Components must continue to reference tokens rather than hard-coded colors.

| Production role | Approved value | Purpose |
|---|---:|---|
| Background | `oklch(0.205 0.007 220)` | Main workspace canvas |
| Foreground | `oklch(0.965 0.008 205)` | Primary text |
| Card / raised surface | `oklch(0.265 0.012 215)` | Scout cards, inbox, panels |
| Popover | `oklch(0.305 0.015 212)` | Menus, hover cards, modals |
| Muted surface | `oklch(0.31 0.014 215)` | Inputs and quiet inset regions |
| Muted foreground | `oklch(0.79 0.015 210)` | Secondary text; must remain readable |
| Warm primary | `oklch(0.79 0.08 78)` | New Scout and high-priority action |
| Pond accent | `oklch(0.56 0.055 200)` | Connect Agent and cool highlights |
| Moonlight | `oklch(0.87 0.025 205)` | Active text and hover illumination |
| Moonlight soft | `oklch(0.48 0.035 205 / 40%)` | Selected rows and active controls |
| Border | `oklch(0.76 0.018 210 / 18%)` | Quiet structural separation |
| Focus ring | `oklch(0.78 0.045 205)` | Keyboard focus |
| Verified | `oklch(0.72 0.09 155)` | Editor-verified state only |
| Warning | `oklch(0.76 0.12 82)` | Needs-review state |
| Conflict / error | `oklch(0.69 0.11 28)` | Contradictions and destructive states |

Add semantic aliases where needed so existing `--color-*` consumers migrate safely. Do not retain the current plum-on-cream palette inside the refreshed authenticated workspace.

### Surface treatment

- Main background: graphite, not near-black.
- Raised surfaces: visibly lighter than the canvas without becoming gray cards floating in black space.
- Use a very subtle cool radial wash near the lower-left or outer edge to suggest reflected pond light.
- Use borders only for separation and focus, not as decorative outlines around every region.
- Rounded panels and controls should follow an approximately `0.75rem–0.9rem` radius family; compact nested elements may use smaller derived radii.
- Do not change the dimensions, padding, grid columns, or responsive ordering of existing layout regions merely to showcase the radius system.

### Explicitly banned effect

Do not use a bright left-edge, right-edge, top-edge, or inset border stripe to indicate selection, activity, or hover. This includes amber rails, partial glowing outlines, and the previously rejected selected-navigation edge treatment.

Selected states must use a full-surface moonlight fill, text/icon contrast, or a quiet uniform shadow.

### Hover and focus behavior

Use 150–200 ms transitions with consistent easing.

- Top-nav actions: slight luminance increase and no more than a 1–2 px visual lift.
- Secondary controls: cool surface fill and clearer foreground.
- Scout cards: slightly brighter surface plus soft, diffuse shadow.
- Information-unit rows: low-opacity moonlight wash; row title may brighten.
- Source links: stronger foreground and optional source Hover Card.
- Destructive actions: retain the conflict/error color and never inherit the warm primary hover.
- Focus-visible: a clear 2 px ring with offset; never remove focus without a replacement.
- Reduced motion: eliminate transforms and reduce transition duration to effectively immediate.

All normal text and controls must meet WCAG AA contrast. Important secondary labels such as workspace descriptions, scout metadata, and modal helper text may not use low-opacity text that becomes unreadable against graphite.

---

## Navigation changes

### Top-navigation geometry

Change the desktop top navigation from a left action cluster to a true three-region layout:

```text
| Scoutpost / contextual back action | New Scout · Connect Agent | credits · user |
```

Requirements:

- The middle action group must be centered relative to the viewport, not merely centered in the remaining space.
- Keep the Scoutpost logo in the left region.
- Keep credits and the user menu in the right region.
- When a scout-creation panel is open, **Back to workspace** remains in the left region and must not displace the centered action group.
- Preserve the current top-nav height and horizontal page padding.
- Keep the two centered actions adjacent with an 8–12 px gap.
- The centered group must not overlap the left or right regions at supported widths.

A CSS grid such as `minmax(0, 1fr) auto minmax(0, 1fr)` is preferred over absolute positioning. The right region should justify to the end. The left region should be allowed to truncate safely before it collides with the actions.

### New Scout

- Preserve the current label, plus icon, chevron, menu contents, Pro locks, and creation-panel callbacks.
- Keep it as the warm primary action.
- The dropdown must anchor to the newly centered trigger rather than using the current hard-coded `left: 228px` position.
- Its placement must remain collision-safe and keyboard accessible.

Prefer the shadcn-svelte Dropdown Menu primitive for anchoring and focus management. If the existing component is retained, remove the obsolete `sidebarCollapsed` positioning contract and calculate placement from the actual trigger.

### Connect Agent

- Label: **Connect Agent**.
- Keep the existing `Bot` icon unless a connection-oriented Lucide icon tests more clearly at 14–16 px.
- Use a persistent pond/steel-teal fill or high-contrast pond-tinted surface; do not render it as a low-contrast ghost button.
- Match the height, radius, type weight, and target size of **New Scout**.
- Hover should brighten the whole surface; no edge rail or pulsing glow.
- Provide `aria-haspopup="dialog"` and a visible focus state.

Update user-facing documentation and setup instructions that explicitly say “click Agents” to say “click Connect Agent.” Do not rename the `AgentsModal` component or API concepts unless separately justified.

### Responsive behavior

- Preserve the existing responsive content layout.
- On wide and standard desktop widths, show both centered labels in full.
- At constrained widths, the action group may reduce horizontal padding before hiding text.
- If an icon-only fallback is unavoidable on narrow mobile widths, preserve accessible names (`New Scout`, `Connect Agent`) and expose the full label through an accessible tooltip.
- The account controls must remain reachable and the navigation must not horizontally scroll.

---

## Secondary filter-bar change

Remove only the scout-name selector currently built from `scoutNameOptions` and displayed as **All scouts**.

The secondary filter bar must retain:

- the location selector;
- the topic selector;
- its current visibility conditions;
- the same height and position;
- the same effects on `dimensionFiltered` scout cards.

Remove the divider that exists only to separate the scout-name selector from location and topic. Do not replace the removed selector with empty space or a different control.

Clean up production code made obsolete by this removal:

- the `Radio` icon import used only by the selector;
- `scoutNameOptions`;
- `selectedScoutName` if it has no remaining consumer;
- `handleScoutFilterChange`;
- assignments that only synchronize `selectedScoutName`.

Do not remove `selectionStore`, `focusedScout`, `handleScoutOpen`, or `handleBackToAll`. Scout-card selection remains the canonical transition between State 1 and State 2.

---

## shadcn-svelte adoption boundary

Use shadcn-svelte as a reusable leaf-component layer, not as permission to rewrite the workspace composition.

The production frontend already uses Svelte 5 and Tailwind 4, so the approved prototype's component approach is compatible. Add only the primitives required by this refresh and keep them under `frontend/src/lib/components/ui/`.

Initial candidates:

- Button
- Badge
- Input
- Separator
- Dropdown Menu
- Hover Card
- Tooltip

Rules:

- Preserve existing domain components such as `ScoutCard`, `ScoutFocus`, `Inbox`, `UnitRow`, `UnitDrawer`, and `AgentsModal`.
- Domain components may compose shadcn primitives internally.
- Do not replace working domain state with component-library state.
- Do not copy the experiment's Vite scaffold or package lock into `frontend/`.
- Use the existing `lucide-svelte` dependency rather than adding a second Lucide package.
- Pin versions compatible with Node 22, the production Svelte version, and the production Tailwind version.
- Generated primitives must use the production `$lib` aliases and tokens.

---

## Scope

### In scope

- The authenticated workspace shell in `frontend/src/routes/+page.svelte`.
- Existing workspace domain components and their visual states.
- Top-nav menus and modals opened from the workspace.
- Scout creation panels rendered inside the workspace.
- Information-unit rows, source links, verification states, and unit drawer.
- Shared product tokens and typography required by those surfaces.
- Documentation and setup copy that names the top-nav Agents action.
- Permanent design-system documentation after the implementation is approved.

### Out of scope

- Changes to scout types, scheduling, credit costs, entitlements, APIs, database schemas, or backend behavior.
- New workspace sections, sidebars, dashboards, metrics, maps, or inspectors.
- Changes to State 1 / State 2 selection semantics.
- Changes to unit verification, rejection, deletion, pagination, search, or source URLs.
- Marketing-page or documentation-page information architecture.
- A light theme or user-selectable theme switcher.
- New notification prompts or promotional onboarding for agents.

The required removal of `design-explorations/night-watch-shadcn-svelte/` is final implementation cleanup and is explicitly in scope.

---

## Implementation units

### U1. Establish the Night Watch token and primitive layer

- **Goal:** Add the approved color, type, radius, focus, and motion system without changing page geometry.
- **Primary files:**
  - `frontend/src/app.css`
  - `frontend/package.json`
  - `frontend/package-lock.json`
  - `frontend/components.json` if shadcn-svelte is initialized there
  - `frontend/src/lib/utils.ts` if required by generated primitives
  - selected files under `frontend/src/lib/components/ui/`
- **Requirements:** Token table, typography, surface rules, focus behavior, reduced motion, banned-effect rule.
- **Constraint:** Do not copy the experiment application shell or its example data.

### U2. Restyle existing workspace components in place

- **Goal:** Apply the approved material and interaction language while preserving all component positions and states.
- **Primary files:**
  - `frontend/src/routes/+page.svelte`
  - `frontend/src/lib/components/ui/FilterBar.svelte`
  - `frontend/src/lib/components/ui/FilterSelect.svelte`
  - `frontend/src/lib/components/workspace/ScoutCard.svelte`
  - `frontend/src/lib/components/workspace/ScoutFocus.svelte`
  - `frontend/src/lib/components/workspace/Inbox.svelte`
  - `frontend/src/lib/components/workspace/UnitRow.svelte`
  - `frontend/src/lib/components/workspace/UnitDrawer.svelte`
  - `frontend/src/lib/components/workspace/NewScoutDropdown.svelte`
  - workspace modals and scout-creation panels that still contain hard-coded legacy visual values
- **Requirements:** Preserve content hierarchy, dimensions, callbacks, loading states, errors, menus, confirmations, and drawer behavior.

### U3. Center the two primary navigation actions

- **Goal:** Make New Scout and Connect Agent persistently visible at the center of the top nav.
- **Primary files:**
  - `frontend/src/routes/+page.svelte`
  - `frontend/src/lib/components/workspace/NewScoutDropdown.svelte`
  - `frontend/src/lib/components/modals/AgentsModal.svelte` only if its trigger contract requires a small reusable adjustment
- **Requirements:** Three-region nav, anchored New Scout menu, Connect Agent label/emphasis, preserved modal state, responsive collision handling.

### U4. Remove the redundant scout selector and lock State 1 / State 2 behavior

- **Goal:** Remove **All scouts** from the secondary nav without removing scout-scoped unit filtering.
- **Primary files:**
  - `frontend/src/routes/+page.svelte`
  - relevant component and workspace-store tests
- **Requirements:** Remove only the third selector and its dead state; preserve location/topic filtering, scout-card focus, back-to-all, search scope, review/all status filters, and deep links.

### U5. Update durable documentation and remove the prototype

- **Goal:** Make the permanent design documentation reflect the implemented Night Watch system and remove the temporary reference frontend so there is only one Scoutpost UI implementation.
- **Primary files:**
  - `DESIGN.md`
  - `frontend/src/routes/docs/+page.svelte`
  - `frontend/src/lib/setup/setup-generator.ts`
  - locale messages if the navigation labels are localized during implementation
  - delete `design-explorations/night-watch-shadcn-svelte/` in full
- **Requirements:** Replace obsolete plum/cream workspace guidance, document the banned edge effect, change instructional references from Agents to Connect Agent, and leave no duplicate prototype components or build scaffold in the repository.
- **Sequence:** Remove the prototype only after the implemented production UI has received visual approval and no production code imports or depends on files inside the experiment. Then delete this temporary spec.

---

## Test requirements

### Component and state tests

Add or update tests that prove:

- New Scout opens the same menu and each scout type still invokes the same callback.
- The New Scout menu is anchored to its centered trigger.
- Connect Agent opens `AgentsModal` in the agents view.
- The user-menu API action still opens the API-only view.
- The secondary nav contains location and topic selectors but no All scouts selector.
- Clicking a scout sets its ID, loads that scout's units, and renders State 2.
- Back to all clears the selected scout, loads all units, and renders State 1.
- Needs review / All filters operate within both scopes.
- Scoped search remains scoped after the visual refresh.
- Unit open, verify, reject, delete, and pagination callbacks are unchanged.
- Keyboard focus can reach both centered actions, every remaining filter, the inbox filters, and row actions.

Existing store tests for `selectionStore` and `unitsStore` must remain green. Add a focused route/component test for the integration between scout selection and unit loading if that behavior is not currently covered above the store level.

### Visual verification matrix

Capture before-and-after screenshots with the same seed data at minimum in:

| View | Width | Required state |
|---|---:|---|
| Workspace | 1440 px | State 1, Needs review |
| Workspace | 1440 px | State 1, All |
| Focused scout | 1440 px | State 2, Needs review |
| Focused scout | 1440 px | State 2, All |
| Workspace | 1024 px | State 1, nav collision check |
| Workspace | 390 px | Responsive nav and inbox |
| New Scout | 1440 px | Centered trigger with menu open |
| Connect Agent | 1440 px | Centered trigger with modal open |
| Information unit | 1440 px | Hover, keyboard focus, drawer open |

Compare layout landmarks rather than only colors:

- top-nav and filter-bar heights;
- scouts/focused-scout region order;
- inbox position and width;
- row action alignment;
- drawer size and attachment;
- responsive stacking order.

Only the nav action position and missing All scouts selector should produce deliberate structural differences.

### Verification commands

Use Node 22 from `frontend/.nvmrc`, then run:

```bash
npm run check
npm test
npm run build
```

Run the existing browser smoke flow and manually exercise the visual matrix. The browser pass must report console errors and horizontal overflow.

---

## Acceptance criteria

- **AC1:** The production workspace uses the approved graphite, moonlight, pond, warm-primary, Manrope, and IBM Plex Mono visual system.
- **AC2:** The workspace retains its existing regions, order, dimensions, and responsive composition except for the two explicitly approved navigation changes.
- **AC3:** New Scout and Connect Agent are centered relative to the viewport at desktop widths and remain fully visible without colliding with logo, credits, or account controls.
- **AC4:** Connect Agent has persistent high contrast, uses the exact label **Connect Agent**, and opens the existing Agents modal in the existing agents state.
- **AC5:** New Scout retains every existing menu option, entitlement gate, and callback, and its menu opens beneath the centered trigger.
- **AC6:** The secondary filter bar shows location and topic selectors and no longer shows All scouts or its dedicated divider.
- **AC7:** Clicking a scout still enters State 2 and filters the information units to that scout.
- **AC8:** Back to all scouts still returns to State 1 and restores the all-scout information-unit set.
- **AC9:** Needs review / All and search continue to operate within the current State 1 or State 2 scope.
- **AC10:** Unit verification, rejection, deletion, drawer, pagination, loading, empty, demo, and error behavior is unchanged.
- **AC11:** Important secondary text meets WCAG AA and remains legible on every graphite surface.
- **AC12:** No selected or hovered element uses the banned bright edge-border or inset-rail effect.
- **AC13:** Interactive elements have visible keyboard focus and reduced-motion behavior.
- **AC14:** shadcn-svelte primitives are reusable leaf components and do not replace domain state or restructure the workspace.
- **AC15:** Type checking, frontend tests, production build, and browser smoke checks pass with no new console errors or horizontal overflow.
- **AC16:** The complete `design-explorations/night-watch-shadcn-svelte/` directory is deleted after production visual approval, and no production import, script, package, or documentation link depends on it.

---

## Completion boundary

Implementation is complete only after:

1. all acceptance criteria pass;
2. the State 1 / State 2 screenshot matrix has been reviewed;
3. the user has approved the production-layout visual pass;
4. `DESIGN.md` reflects the implemented system;
5. obsolete Agents-button instructional copy has been updated;
6. `design-explorations/night-watch-shadcn-svelte/` has been deleted in full;
7. this temporary specification has been deleted.

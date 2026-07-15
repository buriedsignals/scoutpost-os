<script lang="ts">
	import { onDestroy } from 'svelte';
	import { Search } from 'lucide-svelte';
	import Spinner from '$lib/components/ui/Spinner.svelte';
	import UnitRow from './UnitRow.svelte';
	import type { Unit, Scout } from '$lib/types/workspace';

	export let units: Unit[];
	export let loading: boolean;
	export let hasMore: boolean;
	export let filter: 'needs_review' | 'all' = 'needs_review';
	export let scopedToScout: Scout | null = null;
	export let totalCount = 0;
	export let needsReviewCount = 0;
	export let searchQuery = '';
	export let searchPlaceholder = 'Search all inbox units';
	export let isSearching = false;
	export let unitDeleteCandidateId: string | null = null;
	export let deletingUnitId: string | null = null;
	export let verifyingUnitId: string | null = null;
	export let onFilterChange: (filter: 'needs_review' | 'all') => void = () => {};
	export let onSearch: (query: string) => void = () => {};
	export let onOpenUnit: (unit: Unit) => void = () => {};
	export let onVerify: (id: string) => void = () => {};
	export let onReject: (id: string) => void = () => {};
	export let onRequestDelete: (id: string) => void = () => {};
	export let onCancelDelete: (id: string) => void = () => {};
	export let onConfirmDelete: (id: string) => void = () => {};
	export let onLoadMore: () => void = () => {};

	$: headerTitle = scopedToScout ? `${scopedToScout.name} · Inbox` : 'Inbox';
	$: searchActive = searchQuery.trim().length > 0;
	$: searchResultCount = units.length;

	let searchTimer: ReturnType<typeof setTimeout>;

	function handleFilter(next: 'needs_review' | 'all') {
		if (next === filter) return;
		onFilterChange(next);
	}

	function handleSearchInput(event: Event) {
		const query = (event.currentTarget as HTMLInputElement).value;
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => {
			onSearch(query);
		}, 300);
	}

	function clearSearch() {
		clearTimeout(searchTimer);
		onSearch('');
	}

	// --- IntersectionObserver infinite scroll ---

	let sentinel: HTMLDivElement | null = null;
	let observer: IntersectionObserver | null = null;

	function attachObserver(node: HTMLDivElement) {
		sentinel = node;
		if (typeof IntersectionObserver === 'undefined') return;
		observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting && hasMore && !loading) {
						onLoadMore();
					}
				}
			},
			{ rootMargin: '200px 0px' }
		);
		observer.observe(node);
		return {
			destroy() {
				if (observer) {
					observer.disconnect();
					observer = null;
				}
				sentinel = null;
			}
		};
	}

	onDestroy(() => {
		clearTimeout(searchTimer);
		if (observer) {
			observer.disconnect();
			observer = null;
		}
	});

	$: showEmpty = !loading && units.length === 0;
	$: showInitialSpinner = loading && units.length === 0;
</script>

<div class="inbox-wrapper" role="region" aria-label="Information unit inbox">
	<div class="inbox-header">
		<div class="inbox-title-row">
			<h2 class="inbox-title">{headerTitle}</h2>
		</div>
		<div class="inbox-controls">
			<div class="inbox-search-group">
				<label class="inbox-search" aria-label={searchPlaceholder}>
					<Search size={14} class="search-icon" />
					<input
						type="text"
						value={searchQuery}
						placeholder={searchPlaceholder}
						on:input={handleSearchInput}
					/>
					{#if isSearching}
						<Spinner size="sm" />
					{/if}
				</label>
				{#if searchQuery}
					<button type="button" class="clear-search-action" on:click={clearSearch}>
						Clear search
					</button>
				{/if}
			</div>
			{#if searchActive}
				<div class="search-summary-inline">
					<span>{searchResultCount} {searchResultCount === 1 ? 'result' : 'results'} for “{searchQuery}”</span>
				</div>
			{/if}
			<div class="inbox-filter">
				<button
					type="button"
					class="filter-pill needs-review"
					class:active={filter === 'needs_review'}
					on:click={() => handleFilter('needs_review')}
				>
					Needs review · {needsReviewCount}
				</button>
				<button
					type="button"
					class="filter-pill all"
					class:active={filter === 'all'}
					on:click={() => handleFilter('all')}
				>
					All · {totalCount}
				</button>
			</div>
		</div>
	</div>

	<div class="inbox-list">
		{#if showInitialSpinner}
			<div class="list-loading">
				<Spinner size="md" />
			</div>
		{:else if showEmpty}
			{#if searchActive}
				<div class="empty-state">
					<span class="eyebrow eyebrow--primary">Search</span>
					<h3 class="empty-title">No results for “{searchQuery}”</h3>
					<p class="empty-subtitle">
						Try a different query or clear search to return to {scopedToScout ? 'this inbox' : 'all inbox units'}.
					</p>
					<button type="button" class="empty-action-btn" on:click={clearSearch}>
						Clear search
					</button>
				</div>
			{:else}
				<div class="empty-state">
					<span class="eyebrow eyebrow--secondary">Inbox</span>
					<div class="empty-illustration" aria-hidden="true">
						<svg class="empty-illustration__svg" width="72" height="72" viewBox="0 0 72 72" fill="none" xmlns="http://www.w3.org/2000/svg">
							<rect class="ill-tray" x="10" y="18" width="52" height="40" stroke-width="1.5" />
							<path class="ill-tray-lip" d="M10 40h14l3 6h18l3-6h14" stroke-width="1.5" stroke-linejoin="round" />
							<path class="ill-lines" d="M24 28h24M24 34h16" stroke-width="1.5" stroke-linecap="round" />
							<circle class="ill-badge" cx="54" cy="20" r="7" stroke-width="1.5" />
							<path class="ill-badge-hand" d="M54 17v3l2 1.5" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
						</svg>
					</div>
					<h3 class="empty-title">Your inbox is quiet</h3>
					<p class="empty-subtitle">
						Units will land here as your scouts collect them.<br />
						Kick off a run anytime from the <strong>Scouts</strong> panel.
					</p>
				</div>
			{/if}
		{:else}
			{#each units as unit (unit.id)}
				<UnitRow
					{unit}
					confirmingDelete={unitDeleteCandidateId === unit.id}
					deleting={deletingUnitId === unit.id}
					verifying={verifyingUnitId === unit.id}
					showSearchMatch={searchActive}
					onOpen={onOpenUnit}
					onVerify={onVerify}
					onReject={onReject}
					onRequestDelete={onRequestDelete}
					onCancelDelete={onCancelDelete}
					onConfirmDelete={onConfirmDelete}
				/>
			{/each}
			<div class="scroll-sentinel" use:attachObserver></div>
			{#if loading}
				<div class="list-loading small">
					<Spinner size="sm" />
				</div>
			{/if}
		{/if}
	</div>
</div>

<style>
	.inbox-wrapper {
		display: flex;
		flex-direction: column;
	}

	.inbox-header {
		display: flex;
		align-items: center;
		gap: 1.25rem;
		padding: 1.5rem 2rem 0.75rem;
		flex-wrap: wrap;
	}

	.inbox-title-row {
		display: flex;
		align-items: center;
		min-width: 0;
		flex: 0 1 auto;
	}

	.inbox-title {
		font-family: var(--font-display);
		font-size: 1.25rem;
		font-weight: 600;
		color: var(--color-ink);
		margin: 0;
	}

	.inbox-filter {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		margin-left: auto;
		flex-shrink: 0;
	}

	.inbox-controls {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
		margin-left: auto;
		flex: 1 1 26rem;
		justify-content: flex-end;
	}

	.inbox-search-group {
		display: flex;
		align-items: stretch;
		gap: 0.5rem;
		flex: 1 1 24rem;
		justify-content: flex-end;
		flex-wrap: wrap;
	}

	.inbox-search {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		flex: 1 1 22rem;
		min-width: min(24rem, 100%);
		max-width: 32rem;
		padding: 0.5625rem 0.75rem;
		background: var(--color-surface-alt);
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-md);
	}

	.inbox-search:focus-within {
		border-color: var(--ring);
		box-shadow: 0 0 0 3px oklch(0.78 0.045 205 / 12%);
	}

	.inbox-search :global(.search-icon) {
		color: var(--color-ink-subtle);
		flex-shrink: 0;
	}

	.inbox-search input {
		flex: 1;
		min-width: 0;
		border: none;
		outline: none;
		background: transparent;
		font-size: 0.8125rem;
		color: var(--color-ink);
	}

	.inbox-search input::placeholder {
		color: var(--color-ink-subtle);
	}

	.clear-search-action {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0 0.75rem;
		border: 1px solid var(--color-border-strong);
		background: var(--color-surface-alt);
		color: var(--color-ink);
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		cursor: pointer;
		white-space: nowrap;
		border-radius: var(--radius-md);
	}

	.clear-search-action:hover {
		border-color: var(--color-border-strong);
		background: var(--color-surface);
		color: var(--color-ink);
	}

	.search-summary-inline {
		display: inline-flex;
		align-items: center;
		font-size: 0.8125rem;
		color: var(--color-ink-muted);
		white-space: nowrap;
		flex-shrink: 0;
	}

	.search-summary-inline span {
		display: block;
		font-size: 0.8125rem;
		color: var(--color-ink-muted);
	}

	.empty-action-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0.375rem 0.75rem;
		border: 1px solid var(--color-border);
		background: var(--color-surface-alt);
		color: var(--color-ink);
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		cursor: pointer;
	}

	.empty-action-btn:hover {
		border-color: var(--color-primary);
		background: var(--color-primary-soft);
		color: var(--color-primary-deep);
	}

	.filter-pill {
		display: inline-flex;
		align-items: center;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		font-weight: 500;
		padding: 0.3125rem 0.75rem;
		border-radius: var(--radius-pill);
		border: 1px solid var(--color-border);
		background: var(--color-surface-alt);
		color: var(--color-ink-muted);
		cursor: pointer;
		transition: background 150ms ease, border-color 150ms ease, color 150ms ease;
		white-space: nowrap;
	}

	.filter-pill:hover {
		background: var(--color-bg);
		border-color: var(--color-border-strong);
	}

	.filter-pill.needs-review.active {
		background: oklch(0.76 0.12 82 / 14%);
		color: var(--color-warning);
		border-color: oklch(0.76 0.12 82 / 42%);
	}

	.filter-pill.all.active {
		background: oklch(0.48 0.035 205 / 32%);
		color: oklch(0.87 0.025 205);
		border-color: oklch(0.78 0.025 205 / 34%);
	}

	@media (max-width: 900px) {
		.inbox-header {
			align-items: flex-start;
		}

		.inbox-controls {
			width: 100%;
			margin-left: 0;
		}

		.inbox-search-group {
			width: 100%;
			justify-content: flex-start;
		}

		.inbox-search {
			min-width: 100%;
			max-width: none;
		}

		.inbox-filter {
			margin-left: 0;
		}

		.search-summary-inline {
			width: 100%;
			white-space: normal;
		}
	}

	.inbox-list {
		margin: 0 2rem 2rem;
		background: var(--color-surface-alt);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		overflow: hidden;
		box-shadow: 0 18px 44px -30px oklch(0.06 0.015 210 / 60%);
	}

	.list-loading {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 6rem;
	}

	.list-loading.small {
		height: 3rem;
	}

	.scroll-sentinel {
		height: 1px;
		width: 100%;
	}

	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		text-align: center;
		min-height: 22rem;
		padding: 3rem 2rem 3.5rem;
		gap: 0.5rem;
	}

	.empty-illustration {
		display: flex;
		align-items: center;
		justify-content: center;
		margin-top: 0.75rem;
		margin-bottom: 1rem;
	}

	.ill-tray       { fill: var(--color-surface); stroke: var(--color-border); }
	.ill-tray-lip   { fill: var(--color-bg); stroke: var(--color-border-strong); }
	.ill-lines      { stroke: var(--color-border-strong); }
	.ill-badge      { fill: var(--color-secondary-soft); stroke: var(--color-secondary); }
	.ill-badge-hand { stroke: var(--color-secondary); }

	.empty-title {
		font-family: var(--font-display);
		font-size: 1.25rem;
		font-weight: 600;
		color: var(--color-ink);
		margin: 0;
	}

	.empty-subtitle {
		font-family: var(--font-body);
		font-size: 0.875rem;
		line-height: 1.55;
		color: var(--color-ink-muted);
		margin: 0.375rem 0 0;
		max-width: 28rem;
	}

	.empty-subtitle strong {
		color: var(--color-ink);
		font-weight: 600;
	}

</style>

<script lang="ts">
	import { Search, X, RefreshCw } from 'lucide-svelte';
	import Spinner from '$lib/components/ui/Spinner.svelte';
	import * as m from '$lib/paraglide/messages';

	export let onRefresh: (() => void) | undefined = undefined;
	export let isRefreshing = false;

	// Search (optional)
	export let searchEnabled = false;
	export let searchQuery = '';
	export let searchPlaceholder = 'Search...';
	export let onSearch: ((query: string) => void) | undefined = undefined;
	export let isSearching = false;

	let searchTimer: ReturnType<typeof setTimeout>;

	function handleSearchInput(e: Event) {
		const value = (e.target as HTMLInputElement).value;
		searchQuery = value;
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => onSearch?.(value), 300);
	}

	function clearSearch() {
		searchQuery = '';
		onSearch?.('');
	}
</script>

{#if searchEnabled}
	<div class="filter-bar">
		<div class="filters-left"><slot /></div>

		<div class="search-divider"></div>

		<div class="search-field" class:searching={isSearching}>
			<Search size={14} class="search-icon" />
			<input
				type="text"
				value={searchQuery}
				on:input={handleSearchInput}
				placeholder={searchPlaceholder}
			/>
			{#if searchQuery}
				<button class="clear-btn" on:click={clearSearch} aria-label={m.filterBar_clearSearch()}>
					<X size={12} />
				</button>
			{/if}
			{#if isSearching}
				<Spinner size="sm" />
			{/if}
		</div>

		{#if $$slots.toolbar}
			<div class="filters-right"><slot name="toolbar" /></div>
		{/if}
	</div>
{:else}
	<div class="filter-bar">
		{#if onRefresh}
			<button
				class="refresh-btn"
				on:click={onRefresh}
				disabled={isRefreshing}
				aria-label={m.filterBar_refresh()}
			>
				{#if isRefreshing}
				<Spinner size="sm" />
			{:else}
				<RefreshCw size={14} />
			{/if}
			</button>
		{/if}

		<div class="filters-inline">
			<slot />
		</div>
	</div>
{/if}

<style>
	.filter-bar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0 1.25rem;
		height: 53px;
		box-sizing: border-box;
		background: color-mix(in oklch, var(--color-surface-alt) 94%, transparent);
		border-bottom: 1px solid var(--color-border);
		position: relative;
		overflow: visible;
		font-family: var(--font-body);
	}

	.filters-left {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-shrink: 0;
	}

	.filters-right {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-shrink: 0;
	}

	/* Single row inline filters (no search) */
	.filters-inline {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.filters-inline :global(.filter-select) {
		max-width: min(220px, 35vw);
	}

	.refresh-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 30px;
		height: 30px;
		background: var(--color-surface-alt);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		color: var(--color-ink-muted);
		cursor: pointer;
		transition: background 150ms ease, color 150ms ease, border-color 150ms ease;
		flex-shrink: 0;
	}

	.refresh-btn:hover:not(:disabled) {
		background: var(--color-primary-soft);
		color: var(--color-primary);
		border-color: var(--color-primary);
	}

	.refresh-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.search-divider {
		width: 1px;
		height: 20px;
		background: var(--color-border);
		flex-shrink: 0;
	}

	.search-field {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		flex: 1;
		max-width: 440px;
		min-width: 0;
		padding: 0.375rem 0.625rem;
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		transition: border-color 150ms ease, box-shadow 150ms ease;
	}

	.search-field:focus-within {
		border-color: var(--ring);
		box-shadow: 0 0 0 3px oklch(0.78 0.045 205 / 12%);
	}

	.search-field.searching {
		border-color: var(--color-primary);
	}

	.search-field :global(.search-icon) {
		color: var(--color-ink-subtle);
		flex-shrink: 0;
	}

	.search-field input {
		flex: 1;
		min-width: 0;
		border: none;
		background: transparent;
		font-family: var(--font-body);
		font-size: 0.8125rem;
		color: var(--color-ink);
		outline: none;
	}

	.search-field input::placeholder {
		color: var(--color-ink-subtle);
	}

	.clear-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 16px;
		height: 16px;
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-pill);
		color: var(--color-ink-muted);
		cursor: pointer;
		transition: background 150ms ease, color 150ms ease;
		flex-shrink: 0;
	}

	.clear-btn:hover {
		background: var(--color-ink);
		color: var(--color-bg);
	}

</style>

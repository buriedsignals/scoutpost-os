<script lang="ts">
	import { ArrowLeft } from 'lucide-svelte';

	export let label = 'Back';
	export let count: number | null = null;
	export let onClick: () => void = () => {};
</script>

<button class="back-btn" on:click={onClick} type="button">
	<ArrowLeft size={14} strokeWidth={2.25} />
	<span>{label}</span>
	{#if count}
		<span class="back-btn-count">{count}</span>
	{/if}
</button>

<style>
	.back-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.4375rem;
		height: 32px;
		padding: 0 0.75rem;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--color-ink-muted);
		background: var(--color-surface-alt);
		border: 1px solid var(--color-border);
		cursor: pointer;
		transition: border-color 150ms ease, color 150ms ease, background 150ms ease;
	}

	.back-btn:hover,
	.back-btn:focus-visible {
		color: var(--color-primary);
		border-color: var(--color-primary);
		background: var(--color-primary-soft);
	}

	.back-btn:focus-visible {
		outline: 2px solid var(--color-primary);
		outline-offset: 2px;
	}

	.back-btn-count {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 1.25rem;
		height: 1.125rem;
		padding: 0 0.375rem;
		margin-left: 0.125rem;
		font-size: 0.6875rem;
		font-weight: 500;
		color: var(--color-ink-muted);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
	}

	.back-btn:hover .back-btn-count,
	.back-btn:focus-visible .back-btn-count {
		color: var(--color-primary);
		background: var(--color-bg);
	}
</style>

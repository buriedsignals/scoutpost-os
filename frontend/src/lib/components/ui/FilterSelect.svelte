<script lang="ts">
	import { ChevronDown } from 'lucide-svelte';
	import type { ComponentType } from 'svelte';

	type Option = { value: string; label: string; count?: number };

	export let options: Option[];
	export let value: string;
	export let onChange: (value: string) => void;
	export let icon: ComponentType | undefined = undefined;
	export let disabled: boolean = false;

	$: selectedLabel = options.find((o) => o.value === value);
	$: displayText = selectedLabel
		? `${selectedLabel.label}${selectedLabel.count !== undefined ? ` (${selectedLabel.count})` : ''}`
		: '';
</script>

<div class="filter-select" class:disabled>
	{#if icon}
		<svelte:component this={icon} size={14} class="filter-icon" />
	{/if}
	<span class="label">{displayText}</span>
	<ChevronDown size={12} class="chevron" />
	<select {value} {disabled} on:change={(e) => onChange(e.currentTarget.value)}>
		{#each options as opt}
			<option value={opt.value}>
				{opt.label}{opt.count !== undefined ? ` (${opt.count})` : ''}
			</option>
		{/each}
	</select>
</div>

<style>
	.filter-select {
		display: flex;
		align-items: center;
		gap: 0.4375rem;
		position: relative;
		padding: 0.4375rem 1.75rem 0.4375rem 0.75rem;
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		font-family: var(--font-body);
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--color-ink);
		cursor: pointer;
		transition: border-color 150ms ease, background 150ms ease;
		max-width: min(250px, 40vw);
		min-width: 0;
	}

	.filter-select.disabled {
		opacity: 0.45;
		cursor: default;
		pointer-events: none;
	}

	.filter-select:hover:not(.disabled) {
		border-color: var(--color-border-strong);
		background: color-mix(in oklch, var(--color-surface) 82%, var(--color-ink));
	}

	.filter-select:focus-within {
		border-color: var(--ring);
		box-shadow: 0 0 0 3px oklch(0.78 0.045 205 / 12%);
	}

	.filter-select .label {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		pointer-events: none;
	}

	.filter-select :global(.filter-icon) {
		color: var(--color-ink-muted);
		flex-shrink: 0;
	}

	.filter-select select {
		position: absolute;
		inset: 0;
		border: none;
		background: transparent;
		font-size: inherit;
		font-family: inherit;
		color: transparent;
		cursor: pointer;
		outline: none;
		appearance: none;
		opacity: 0;
		width: 100%;
		height: 100%;
	}

	.filter-select :global(.chevron) {
		position: absolute;
		right: 0.5rem;
		top: 50%;
		transform: translateY(-50%);
		color: var(--color-ink-subtle);
		pointer-events: none;
	}
</style>

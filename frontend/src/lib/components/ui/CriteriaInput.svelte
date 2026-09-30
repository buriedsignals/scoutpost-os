<script lang="ts">
	import * as m from '$lib/paraglide/messages';

	export let value = '';
	export let placeholder = '';
	export let rows = 2;
	export let examples: { label: string; value: string }[] = [];
	export let inputId: string | undefined = undefined;
	export let required = false;
</script>

<div class="criteria-field">
	<textarea
		id={inputId}
		{required}
		maxlength="4000"
		bind:value
		{placeholder}
		{rows}
		class="criteria-textarea"
	></textarea>
	{#if !value.trim() && examples.length > 0}
		<div class="criteria-pills">
			<span class="criteria-pills-label">{m.webScout_criteriaExamplesLabel()}</span>
			{#each examples as ex}
				<button type="button" class="criteria-pill" on:click={() => value = ex.value}>{ex.label}</button>
			{/each}
		</div>
	{/if}
</div>

<style>
	.criteria-field {
		border: 1px solid var(--color-border);
		background: var(--color-bg);
		transition: border-color 150ms ease, box-shadow 150ms ease;
		overflow: hidden;
	}

	.criteria-field:focus-within {
		border-color: var(--color-primary);
		box-shadow: 0 0 0 3px var(--color-primary-soft);
	}

	.criteria-field:hover:not(:focus-within) {
		border-color: var(--color-border-strong);
	}

	.criteria-textarea {
		width: 100%;
		padding: 0.625rem 0.875rem;
		border: none;
		background: transparent;
		font-size: 0.875rem;
		font-family: var(--font-body);
		color: var(--color-ink);
		resize: none;
		outline: none;
	}

	.criteria-textarea::placeholder { color: var(--color-ink-subtle); }

	.criteria-pills {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.375rem;
		padding: 0 0.875rem 0.625rem;
	}

	.criteria-pills-label {
		font-family: var(--font-mono);
		font-size: 0.625rem;
		font-weight: 500;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--color-ink-subtle);
	}

	.criteria-pill {
		padding: 0.25rem 0.625rem;
		font-family: var(--font-body);
		font-size: 0.75rem;
		font-weight: 500;
		background: var(--color-surface-alt);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-pill);
		cursor: pointer;
		transition: background 150ms ease, border-color 150ms ease, color 150ms ease;
		color: var(--color-ink-muted);
	}

	.criteria-pill:hover {
		background: var(--color-primary-soft);
		border-color: var(--color-primary);
		color: var(--color-primary-deep);
	}
</style>

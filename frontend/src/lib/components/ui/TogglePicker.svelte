<script lang="ts">
	export let value: string;
	export let options: { value: string; label: string; description: string }[];
	export let onChange: (value: string) => void = () => {};

	function select(option: string) {
		value = option;
		onChange(option);
	}
</script>

<div class="toggle-picker" role="radiogroup">
	{#each options as option}
		<button
			type="button"
			class="toggle-option"
			class:active={value === option.value}
			role="radio"
			aria-checked={value === option.value}
			on:click={() => select(option.value)}
		>
			<span class="toggle-name">{option.label}</span>
			<span class="toggle-desc">{option.description}</span>
		</button>
	{/each}
</div>

<style>
	.toggle-picker { display: flex; gap: 0; border: 1px solid var(--color-border); background: var(--color-bg); }
	.toggle-option { flex: 1; padding: 12px 14px; text-align: center; border: none; border-right: 1px solid var(--color-border); cursor: pointer; transition: background 150ms ease; background: transparent; font-family: var(--font-body); }
	.toggle-option:last-child { border-right: none; }
	.toggle-option:hover:not(.active) { background: var(--color-surface); }
	.toggle-option.active { background: var(--color-primary-soft); }
	.toggle-option .toggle-name { display: block; font-size: 0.8125rem; font-weight: 600; color: var(--color-ink-muted); }
	.toggle-option.active .toggle-name { color: var(--color-primary-deep); }
	.toggle-option .toggle-desc { display: block; font-size: 0.6875rem; font-weight: 500; color: var(--color-ink-subtle); text-align: center; margin-top: 3px; }
	.toggle-option.active .toggle-desc { color: var(--color-ink-muted); }
</style>

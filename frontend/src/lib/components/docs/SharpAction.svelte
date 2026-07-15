<script lang="ts">
	export let href: string | undefined = undefined;
	export let active = false;
	export let variant: 'surface' | 'primary' | 'ghost' = 'surface';
	export let size: 'sm' | 'md' = 'md';
	export let target: string | undefined = undefined;
	export let rel: string | undefined = undefined;
	export let ariaLabel: string | undefined = undefined;
	export let type: 'button' | 'submit' | 'reset' = 'button';
	export let className = '';
</script>

{#if href}
	<a
		href={href}
		target={target}
		rel={rel}
		aria-label={ariaLabel}
		class={`sharp-action ${variant} ${size} ${active ? 'active' : ''} ${className}`.trim()}
	>
		<slot />
	</a>
{:else}
	<button
		type={type}
		aria-label={ariaLabel}
		class={`sharp-action ${variant} ${size} ${active ? 'active' : ''} ${className}`.trim()}
	>
		<slot />
	</button>
{/if}

<style>
	.sharp-action {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		text-decoration: none;
		cursor: pointer;
		transition:
			color 150ms ease,
			background-color 150ms ease,
			border-color 150ms ease;
		font-family: var(--font-body);
		font-weight: 600;
		line-height: 1.2;
	}

	.sharp-action.sm {
		padding: 0.5rem 0.875rem;
		font-size: 0.8125rem;
	}

	.sharp-action.md {
		padding: 0.75rem 1.25rem;
		font-size: 0.9375rem;
	}

	.sharp-action.surface {
		background: var(--color-surface-alt);
		color: var(--color-ink);
	}

	.sharp-action.surface:hover,
	.sharp-action.surface.active {
		border-color: var(--color-border-strong);
		background: var(--color-surface-hover);
		color: var(--color-ink);
	}

	.sharp-action.surface.active {
		background: var(--color-primary-soft);
	}

	.sharp-action.primary {
		background: var(--color-primary);
		border-color: var(--color-primary);
		color: var(--color-bg);
	}

	.sharp-action.primary:hover,
	.sharp-action.primary.active {
		background: var(--color-primary-deep);
		border-color: var(--color-primary-deep);
		color: var(--color-bg);
	}

	.sharp-action.ghost {
		background: transparent;
		color: var(--color-ink-muted);
	}

	.sharp-action.ghost:hover,
	.sharp-action.ghost.active {
		border-color: var(--color-border-strong);
		background: var(--color-secondary-soft);
		color: var(--color-ink);
	}
</style>

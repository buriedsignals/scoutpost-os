<script lang="ts">
	export let href: string | undefined = undefined;
	export let tone: 'surface' | 'soft' | 'warning' = 'surface';
	export let className = '';
	export let target: string | undefined = undefined;
	export let rel: string | undefined = undefined;
</script>

{#if href}
	<a
		href={href}
		target={target}
		rel={rel}
		class={`sharp-panel ${tone} interactive ${className}`.trim()}
	>
		<slot />
	</a>
{:else}
	<div class={`sharp-panel ${tone} ${className}`.trim()}>
		<slot />
	</div>
{/if}

<style>
	.sharp-panel {
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		background: var(--color-surface-alt);
		color: var(--color-ink);
	}

	.sharp-panel.surface {
		background: var(--color-surface-alt);
	}

	.sharp-panel.soft {
		background: var(--color-surface);
	}

	.sharp-panel.warning {
		background: var(--color-secondary-soft);
		border-color: color-mix(in srgb, var(--color-secondary) 28%, var(--color-border));
	}

	.sharp-panel.interactive {
		display: block;
		text-decoration: none;
		transition:
			border-color 150ms ease,
			color 150ms ease,
			background-color 150ms ease;
	}

	.sharp-panel.interactive:hover {
		border-color: var(--color-border-strong);
		background: var(--color-surface-hover);
		color: var(--color-ink);
	}
</style>

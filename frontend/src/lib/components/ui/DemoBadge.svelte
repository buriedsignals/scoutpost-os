<script lang="ts">
	export let variant: 'ribbon' | 'pill' = 'pill';
	export let label = 'DEMO';
</script>

<span class="demo-badge {variant}" aria-label="Example data — read-only">{label}</span>

<style>
	.demo-badge {
		display: inline-flex;
		align-items: center;
		font-weight: 700;
		letter-spacing: 0.1em;
		color: var(--color-foreground);
		background: color-mix(in oklab, var(--color-pond) 70%, var(--color-card));
		border-radius: var(--radius-md);
		box-shadow: 0 0 0 1px color-mix(in oklab, var(--color-pond) 40%, transparent);
		white-space: nowrap;
		pointer-events: none;
	}

	.demo-badge.pill {
		font-size: 0.625rem;
		padding: 0.1875rem 0.5rem;
	}

	.demo-badge.ribbon {
		position: absolute;
		top: 0.625rem;
		right: 0.625rem;
		font-size: 0.625rem;
		padding: 0.1875rem 0.5rem;
		z-index: 1;
	}
</style>

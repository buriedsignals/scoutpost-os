<script lang="ts">
	export let value: string | number;
	export let label: string;
	export let title: string | undefined = undefined;
</script>

<div class="metric-pill" {title}>
	<span class="metric-pill__inner">
		<span class="metric-pill__value">{value}</span>
		<span class="metric-pill__label">{label}</span>
	</span>
</div>

<style>
	.metric-pill {
		display: inline-grid;
		place-items: center;
		min-height: 32px;
		padding: 0.375rem 0.75rem;
		background: var(--color-secondary-soft);
		border: 1px solid oklch(0.56 0.055 200 / 40%);
		border-radius: var(--radius-lg);
		white-space: nowrap;
		box-sizing: border-box;
	}

	.metric-pill__inner {
		display: inline-flex;
		align-items: baseline;
		gap: 0.375rem;
		line-height: 1;
	}

	.metric-pill__value {
		display: inline-flex;
		align-items: center;
		font-family: var(--font-mono);
		font-size: 0.75rem;
		font-weight: 700;
		line-height: 1;
		font-variant-numeric: tabular-nums lining-nums;
		color: var(--color-ink);
	}

	.metric-pill__label {
		display: inline-flex;
		align-items: center;
		font-family: var(--font-mono);
		font-size: 0.75rem;
		font-weight: 500;
		line-height: 1;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: oklch(0.76 0.065 200);
		white-space: nowrap;
	}
</style>

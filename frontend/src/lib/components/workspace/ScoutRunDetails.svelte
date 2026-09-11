<script lang="ts">
	import type { ScoutRunDetail } from '$lib/utils/scouts';
	export let details: ScoutRunDetail[];
</script>

{#each details as detail}
	<p
		class="run-detail"
		class:run-detail-warning={detail.kind === 'warning'}
		class:run-detail-error={detail.kind === 'error'}
	>{detail.message}</p>
{/each}

<style>
	.run-detail {
		font-size: 0.75rem;
		line-height: 1.4;
		color: var(--color-text-secondary);
		margin: 0 0 0.5rem;
	}
	.run-detail-warning { color: var(--color-warning, #92400e); }
	.run-detail-error { color: var(--color-error, #b91c1c); }
</style>

<script lang="ts">
	import * as m from '$lib/paraglide/messages';

	export let onOpen: () => void = () => {};

	function openBugReport() {
		onOpen();
	}
</script>

<button
	on:click={openBugReport}
	class="bug-report-button"
	aria-label={m.bugReport_label()}
	title={m.bugReport_label()}
>
	<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>
		<path d="M9.1 9a3 3 0 0 1 5.82 1c0 2-3 3-3 3"/>
		<path d="M12 17h.01"/>
	</svg>
</button>

<style>
	.bug-report-button {
		position: fixed;
		bottom: 1.25rem;
		right: 1.25rem;
		z-index: 50;

		width: 48px;
		height: 48px;
		border-radius: var(--radius-md);

		background: var(--secondary);
		border: 1px solid var(--border);
		color: var(--secondary-foreground);
		box-shadow: var(--shadow-md);

		display: flex;
		align-items: center;
		justify-content: center;

		cursor: pointer;
		transition: background 150ms ease, border-color 150ms ease;
	}

	.bug-report-button:hover {
		background: var(--accent);
		border-color: var(--ring);
		color: var(--accent-foreground);
	}

	.bug-report-button:focus-visible {
		outline: 2px solid var(--color-primary);
		outline-offset: 2px;
	}

	.bug-report-button svg {
		flex-shrink: 0;
	}
</style>

<script lang="ts">
	import { Check, Copy } from 'lucide-svelte';

	export let code = '';
	export let copyValue: string | undefined = undefined;
	export let ariaLabel = 'Copy code';

	let copied = false;

	async function copyToClipboard() {
		await navigator.clipboard.writeText(copyValue ?? code);
		copied = true;
		setTimeout(() => {
			copied = false;
		}, 1500);
	}
</script>

<div class="code-shell">
	<button class="copy-button" type="button" aria-label={ariaLabel} on:click={copyToClipboard}>
		{#if copied}
			<Check size={14} />
		{:else}
			<Copy size={14} />
		{/if}
	</button>
	<pre><code>{code}</code></pre>
</div>

<style>
	.code-shell {
		position: relative;
	}

	.copy-button {
		position: absolute;
		top: 0.75rem;
		right: 0.75rem;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2.25rem;
		height: 2.25rem;
		border: 1px solid rgba(255, 255, 255, 0.18);
		border-radius: var(--radius-md);
		background: rgba(255, 255, 255, 0.06);
		color: var(--color-bg);
		cursor: pointer;
		transition:
			background-color 150ms ease,
			border-color 150ms ease,
			color 150ms ease;
	}

	.copy-button:hover {
		background: rgba(255, 255, 255, 0.14);
		border-color: rgba(255, 255, 255, 0.32);
	}

	pre {
		margin: 0;
		padding: 1rem 4rem 1rem 1rem;
		background: oklch(0.18 0.01 215);
		color: var(--color-ink);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		line-height: 1.7;
		overflow-x: auto;
		white-space: pre-wrap;
		word-break: break-word;
	}

	code {
		font-family: inherit;
	}
</style>

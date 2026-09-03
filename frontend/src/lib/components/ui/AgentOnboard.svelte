<script lang="ts">
	import { Copy, Check } from 'lucide-svelte';

	/** The "Onboard your agent" block: the first message to paste once connected. */
	export let prompt: string;
	export let hint: string = '';

	let copied = false;
	let copyFallback = '';

	async function copy() {
		copyFallback = '';
		try {
			await navigator.clipboard.writeText(prompt);
			copied = true;
			setTimeout(() => {
				copied = false;
			}, 1500);
		} catch {
			copied = false;
			copyFallback = prompt;
		}
	}
</script>

<div class="block onboard">
	<div class="block-head">
		<span class="block-label">Onboard your agent</span>
		<button class="copy-btn" on:click={copy}>
			{#if copied}
				<Check size={13} /><span>Copied</span>
			{:else}
				<Copy size={13} /><span>Copy</span>
			{/if}
		</button>
	</div>
	{#if hint}
		<p class="block-note">{hint}</p>
	{/if}
	<pre><code>{prompt}</code></pre>
	{#if copyFallback}
		<div class="copy-fallback" role="alert">
			<p>Clipboard access is blocked. Select and copy this text:</p>
			<textarea readonly value={copyFallback} on:focus={(event) => event.currentTarget.select()}></textarea>
		</div>
	{/if}
</div>

<style>
	.block {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		margin-top: 0.9rem;
	}

	.block-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}

	.block-label {
		font-size: 0.72rem;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-muted, #6b7280);
	}

	.block-note {
		margin: 0;
		font-size: 0.8rem;
		color: var(--text-muted, #6b7280);
	}

	.copy-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		padding: 0.25rem 0.55rem;
		font: inherit;
		font-size: 0.75rem;
		color: var(--text-muted, #6b7280);
		background: transparent;
		border: 1px solid var(--border, rgba(0, 0, 0, 0.12));
		border-radius: 6px;
		cursor: pointer;
	}

	pre {
		margin: 0;
		padding: 0.7rem 0.85rem;
		font-size: 0.8rem;
		line-height: 1.45;
		white-space: pre-wrap;
		word-break: break-word;
		background: var(--surface-sunken, rgba(0, 0, 0, 0.04));
		border: 1px solid var(--border, rgba(0, 0, 0, 0.12));
		border-radius: 8px;
	}

	.copy-fallback textarea {
		width: 100%;
		min-height: 5rem;
		font: inherit;
		font-size: 0.8rem;
	}
</style>

<script lang="ts">
	import { AlertCircle, Copy, Check, ExternalLink } from 'lucide-svelte';
	import type { Recipe } from '$lib/utils/agent-recipes';

	export let recipe: Recipe;

	let copied: string | null = null;

	function copy(key: string, text: string) {
		navigator.clipboard.writeText(text);
		copied = key;
		setTimeout(() => {
			if (copied === key) copied = null;
		}, 1500);
	}
</script>

<div class="setup">
	<p class="tagline">{recipe.tagline}</p>

	{#if recipe.warning}
		<div class="warning" role="note">
			<AlertCircle size={16} class="warning-icon" />
			<div>
				<p class="warning-title">{recipe.warning.title}</p>
				<p class="warning-body">{recipe.warning.body}</p>
			</div>
		</div>
	{/if}

	{#if recipe.video}
		<div class="video-block">
			<video controls preload="metadata" aria-label={recipe.video.title}>
				<source src={recipe.video.src} type="video/mp4" />
			</video>
		</div>
	{/if}

	{#if recipe.mode === 'cli-command' && recipe.command}
		<div class="block">
			<div class="block-head">
				<span class="block-label">Run this in your terminal</span>
				<button class="copy-btn" on:click={() => copy('cmd', recipe.command ?? '')}>
					{#if copied === 'cmd'}
						<Check size={13} /><span>Copied</span>
					{:else}
						<Copy size={13} /><span>Copy</span>
					{/if}
				</button>
			</div>
			<pre><code>{recipe.command}</code></pre>
		</div>

		{#if recipe.uiSteps}
			<ol class="steps">
				{#each recipe.uiSteps as step, i}
					<li><span class="step-num">{i + 1}</span><span class="step-body">{step}</span></li>
				{/each}
			</ol>
		{/if}

		{#if recipe.configSnippet}
			<div class="block">
				<div class="block-head">
					<span class="block-label">
						{recipe.configLang ? 'Reference config' : 'Remote MCP URL'}
					</span>
					<button class="copy-btn" on:click={() => copy('snippet', recipe.configSnippet ?? '')}>
						{#if copied === 'snippet'}
							<Check size={13} /><span>Copied</span>
						{:else}
							<Copy size={13} /><span>Copy</span>
						{/if}
					</button>
				</div>
				<pre class="lang-{recipe.configLang ?? 'text'}"><code>{recipe.configSnippet}</code></pre>
			</div>
		{/if}
	{:else if recipe.mode === 'cli-install' && recipe.installCommand}
		<div class="block">
			<div class="block-head">
				<span class="block-label">
					Install <code class="path">cojo</code>
				</span>
				<button class="copy-btn" on:click={() => copy('install', recipe.installCommand ?? '')}>
					{#if copied === 'install'}
						<Check size={13} /><span>Copied</span>
					{:else}
						<Copy size={13} /><span>Copy</span>
					{/if}
				</button>
			</div>
			<pre><code>{recipe.installCommand}</code></pre>
			<p class="block-note">Requires Deno 2.x. The command installs from source and works across supported platforms.</p>
		</div>

		{#if recipe.configCommands?.length}
			<div class="block">
				<div class="block-head">
					<span class="block-label">Configure</span>
					<button
						class="copy-btn"
						on:click={() => copy('config', (recipe.configCommands ?? []).join('\n'))}
					>
						{#if copied === 'config'}
							<Check size={13} /><span>Copied</span>
						{:else}
							<Copy size={13} /><span>Copy</span>
						{/if}
					</button>
				</div>
				<pre><code>{recipe.configCommands.join('\n')}</code></pre>
				<p class="block-note">
					Need a key? Click the <strong>API</strong> button at the top of this modal, then
					<strong>Create key</strong> — you&rsquo;ll get a <code>cj_…</code> value to paste in place of
					the placeholder. Revoke or rotate from the same panel anytime.
				</p>
			</div>
		{/if}
	{:else if recipe.mode === 'config-file' && recipe.configSnippet}
		<div class="block">
			<div class="block-head">
				<span class="block-label">
					Add to <code class="path">{recipe.configPath}</code>
				</span>
				<button class="copy-btn" on:click={() => copy('cfg', recipe.configSnippet ?? '')}>
					{#if copied === 'cfg'}
						<Check size={13} /><span>Copied</span>
					{:else}
						<Copy size={13} /><span>Copy</span>
					{/if}
				</button>
			</div>
			<pre class="lang-{recipe.configLang ?? 'json'}"><code>{recipe.configSnippet}</code></pre>
		</div>
	{:else if recipe.mode === 'ui-steps' && recipe.uiSteps && recipe.configSnippet}
		<ol class="steps">
			{#each recipe.uiSteps as step, i}
				<li><span class="step-num">{i + 1}</span><span class="step-body">{step}</span></li>
			{/each}
		</ol>
		<div class="block">
			<div class="block-head">
				<span class="block-label">Remote MCP URL</span>
				<button class="copy-btn" on:click={() => copy('url', recipe.configSnippet ?? '')}>
					{#if copied === 'url'}
						<Check size={13} /><span>Copied</span>
					{:else}
						<Copy size={13} /><span>Copy URL</span>
					{/if}
				</button>
			</div>
			<pre><code>{recipe.configSnippet}</code></pre>
		</div>
	{:else if recipe.mode === 'generic' && recipe.configSnippet}
		<div class="block">
			<div class="block-head">
				<span class="block-label">Remote MCP URL</span>
				<button class="copy-btn" on:click={() => copy('url', recipe.configSnippet ?? '')}>
					{#if copied === 'url'}
						<Check size={13} /><span>Copied</span>
					{:else}
						<Copy size={13} /><span>Copy URL</span>
					{/if}
				</button>
			</div>
			<pre><code>{recipe.configSnippet}</code></pre>
		</div>
	{/if}

	<div class="verify">
		<span class="verify-label">Verify it works</span>
		{#if recipe.verifySteps?.length}
			<ol class="verify-steps">
				{#each recipe.verifySteps as step}
					<li>{step}</li>
				{/each}
			</ol>
		{:else}
			<p>
				Ask your AI:
				<em>&ldquo;{recipe.verifyPrompt ?? 'List my coJournalist scouts'}&rdquo;</em>
				&mdash; if it returns your scouts, you&rsquo;re connected.
			</p>
		{/if}
	</div>

	{#if recipe.docsUrl}
		<a class="docs-link" href={recipe.docsUrl} target="_blank" rel="noopener">
			<ExternalLink size={12} />
			<span>{recipe.docsLabel ?? 'Official docs'}</span>
		</a>
	{/if}
</div>

<style>
	.setup {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.tagline {
		font-size: 0.9375rem;
		color: var(--color-ink);
		margin: 0;
		line-height: 1.5;
	}

	.warning {
		display: flex;
		align-items: flex-start;
		gap: 0.625rem;
		padding: 0.75rem 0.875rem;
		background: #fff7ed;
		border: 1px solid #fed7aa;
		border-radius: 0;
	}
	:global(.setup .warning-icon) {
		color: #c2410c;
		flex-shrink: 0;
		margin-top: 0.125rem;
	}
	.warning-title {
		font-size: 0.8125rem;
		font-weight: 600;
		color: #9a3412;
		margin: 0 0 0.1875rem 0;
	}
	.warning-body {
		font-size: 0.8125rem;
		color: #7c2d12;
		margin: 0;
		line-height: 1.5;
	}

	.video-block {
		border: 1px solid var(--color-border);
		background: #111827;
	}
	.video-block video {
		display: block;
		width: 100%;
		aspect-ratio: 16 / 9;
		background: #111827;
	}

	.block {
		border: 1px solid var(--color-border);
		border-radius: 0;
		overflow: hidden;
	}
	.block-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.5rem 0.75rem;
		background: var(--color-bg);
		border-bottom: 1px solid var(--color-border);
		font-size: 0.8125rem;
	}
	.block-label {
		font-weight: 600;
		color: var(--color-ink);
	}
	.block-label .path {
		font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.75rem;
		padding: 0.0625rem 0.3125rem;
		background: rgba(78, 44, 120, 0.1);
		color: var(--color-primary-deep);
		border-radius: 0;
		font-weight: 500;
	}
	.copy-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.25rem 0.5rem;
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--color-ink-muted);
		background: var(--color-surface-alt);
		border: 1px solid var(--color-border);
		border-radius: 0;
		cursor: pointer;
		transition: all 0.15s ease;
	}
	.copy-btn:hover {
		background: #faf9ff;
		color: #4E2C78;
		border-color: #d4d4f7;
	}

	pre {
		margin: 0;
		padding: 0.875rem 1rem;
		background: #1c1917;
		color: #f5f5f4;
		font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.8125rem;
		line-height: 1.6;
		overflow-x: auto;
	}

	.block-note {
		margin: 0;
		padding: 0.5rem 0.875rem;
		background: #fafafa;
		border-top: 1px solid var(--color-border);
		font-size: 0.75rem;
		color: var(--color-ink-muted);
		line-height: 1.5;
	}
	.block-note code {
		font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.6875rem;
		padding: 0.0625rem 0.3125rem;
		background: rgba(78, 44, 120, 0.1);
		color: var(--color-primary-deep);
		border-radius: 0;
	}

	.steps {
		margin: 0;
		padding: 0;
		list-style: none;
		counter-reset: step;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.steps li {
		display: grid;
		grid-template-columns: 1.5rem 1fr;
		gap: 0.75rem;
		align-items: start;
		font-size: 0.875rem;
		color: var(--color-ink);
		line-height: 1.5;
		position: relative;
	}
	.steps li:not(:last-child)::before {
		content: '';
		position: absolute;
		left: 0.75rem;
		top: 1.625rem;
		bottom: -0.5rem;
		width: 1px;
		background: #e5e7eb;
		transform: translateX(-0.5px);
	}
	.step-num {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		background: linear-gradient(135deg, #4E2C78 0%, #5b4bbd 100%);
		color: white;
		font-size: 0.75rem;
		font-weight: 600;
		border-radius: 999px;
		box-shadow: 0 1px 2px rgba(91, 75, 189, 0.25);
		font-variant-numeric: tabular-nums;
	}
	.step-body {
		padding-top: 0.1875rem;
	}
	.step-body :global(code) {
		font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.8125rem;
		padding: 0.0625rem 0.3125rem;
		background: rgba(78, 44, 120, 0.1);
		color: var(--color-primary-deep);
		border-radius: 0;
	}

	.verify {
		padding: 0.75rem 0.875rem;
		background: #f0fdf4;
		border: 1px solid #bbf7d0;
		border-radius: 0;
	}
	.verify-label {
		display: block;
		font-size: 0.75rem;
		font-weight: 700;
		color: #166534;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		margin-bottom: 0.25rem;
	}
	.verify p {
		margin: 0;
		font-size: 0.8125rem;
		color: #166534;
		line-height: 1.5;
	}
	.verify-steps {
		margin: 0;
		padding-left: 1.125rem;
		font-size: 0.8125rem;
		color: #166534;
		line-height: 1.5;
	}
	.verify-steps li + li {
		margin-top: 0.25rem;
	}
	.verify em {
		font-style: normal;
		font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.75rem;
		padding: 0.0625rem 0.3125rem;
		background: rgba(22, 101, 52, 0.1);
		border-radius: 0;
	}

	.docs-link {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-size: 0.8125rem;
		color: var(--color-primary-deep);
		text-decoration: none;
		font-weight: 500;
	}
	.docs-link:hover {
		text-decoration: underline;
	}
</style>

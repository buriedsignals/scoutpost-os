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
					Install <code class="path">scout</code>
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
					Need a key? Open <strong>Connect Agent → API keys &amp; REST</strong>, then
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
				<span class="block-label">{recipe.configLang ? 'Configuration' : 'Remote MCP URL'}</span>
				<button class="copy-btn" on:click={() => copy('setup', recipe.configSnippet ?? '')}>
					{#if copied === 'setup'}
						<Check size={13} /><span>Copied</span>
					{:else}
						<Copy size={13} /><span>{recipe.configLang ? 'Copy config' : 'Copy URL'}</span>
					{/if}
				</button>
			</div>
			<pre class="lang-{recipe.configLang ?? 'text'}"><code>{recipe.configSnippet}</code></pre>
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
				<em>&ldquo;{recipe.verifyPrompt ?? 'List my Scoutpost scouts'}&rdquo;</em>
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
		background: color-mix(in oklab, var(--color-warning) 10%, var(--color-card));
		border: 1px solid color-mix(in oklab, var(--color-warning) 34%, var(--color-border));
		border-radius: var(--radius-md);
	}
	:global(.setup .warning-icon) {
		color: var(--color-warning);
		flex-shrink: 0;
		margin-top: 0.125rem;
	}
	.warning-title {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--color-foreground);
		margin: 0 0 0.1875rem 0;
	}
	.warning-body {
		font-size: 0.8125rem;
		color: var(--color-muted-foreground);
		margin: 0;
		line-height: 1.5;
	}

	.video-block {
		border: 1px solid var(--color-border);
		background: color-mix(in oklab, var(--color-background) 88%, black);
	}
	.video-block video {
		display: block;
		width: 100%;
		aspect-ratio: 16 / 9;
		background: color-mix(in oklab, var(--color-background) 88%, black);
	}

	.block {
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
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
		font-family: var(--font-mono);
		font-size: 0.75rem;
		padding: 0.0625rem 0.3125rem;
		background: color-mix(in oklab, var(--color-moonlight) 12%, transparent);
		color: var(--color-moonlight);
		border-radius: var(--radius-md);
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
		border-radius: var(--radius-md);
		cursor: pointer;
		transition: all 0.15s ease;
	}
	.copy-btn:hover {
		background: var(--color-surface-hover);
		color: var(--color-foreground);
		border-color: var(--color-border-strong);
		transform: translateY(-1px);
	}

	pre {
		margin: 0;
		padding: 0.875rem 1rem;
		background: color-mix(in oklab, var(--color-background) 90%, black);
		color: var(--color-foreground);
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		line-height: 1.6;
		overflow-x: auto;
	}

	.block-note {
		margin: 0;
		padding: 0.5rem 0.875rem;
		background: var(--color-surface-alt);
		border-top: 1px solid var(--color-border);
		font-size: 0.75rem;
		color: var(--color-ink-muted);
		line-height: 1.5;
	}
	.block-note code {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		padding: 0.0625rem 0.3125rem;
		background: color-mix(in oklab, var(--color-moonlight) 12%, transparent);
		color: var(--color-moonlight);
		border-radius: var(--radius-md);
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
		background: var(--color-border);
		transform: translateX(-0.5px);
	}
	.step-num {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		background: color-mix(in oklab, var(--color-pond) 72%, var(--color-card));
		color: var(--color-foreground);
		font-size: 0.75rem;
		font-weight: 600;
		border-radius: 999px;
		box-shadow: 0 0 0 1px color-mix(in oklab, var(--color-pond) 45%, transparent);
		font-variant-numeric: tabular-nums;
	}
	.step-body {
		padding-top: 0.1875rem;
	}
	.step-body :global(code) {
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		padding: 0.0625rem 0.3125rem;
		background: color-mix(in oklab, var(--color-moonlight) 12%, transparent);
		color: var(--color-moonlight);
		border-radius: var(--radius-md);
	}

	.verify {
		padding: 0.75rem 0.875rem;
		background: color-mix(in oklab, var(--color-success) 9%, var(--color-card));
		border: 1px solid color-mix(in oklab, var(--color-success) 30%, var(--color-border));
		border-radius: var(--radius-md);
	}
	.verify-label {
		display: block;
		font-size: 0.75rem;
		font-weight: 700;
		color: var(--color-success);
		text-transform: uppercase;
		letter-spacing: 0.06em;
		margin-bottom: 0.25rem;
	}
	.verify p {
		margin: 0;
		font-size: 0.8125rem;
		color: var(--color-foreground);
		line-height: 1.5;
	}
	.verify-steps {
		margin: 0;
		padding-left: 1.125rem;
		font-size: 0.8125rem;
		color: var(--color-foreground);
		line-height: 1.5;
	}
	.verify-steps li + li {
		margin-top: 0.25rem;
	}
	.verify em {
		font-style: normal;
		font-family: var(--font-mono);
		font-size: 0.75rem;
		padding: 0.0625rem 0.3125rem;
		background: color-mix(in oklab, var(--color-success) 12%, transparent);
		border-radius: var(--radius-md);
	}

	.docs-link {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-size: 0.8125rem;
		color: var(--color-moonlight);
		text-decoration: none;
		font-weight: 500;
	}
	.docs-link:hover {
		text-decoration: underline;
	}
</style>

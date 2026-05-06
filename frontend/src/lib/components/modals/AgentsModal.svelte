<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { X, Eye, Copy, Check, Code2, Download } from 'lucide-svelte';
	import AgentSelect from '$lib/components/ui/AgentSelect.svelte';
	import AgentSetup from '$lib/components/ui/AgentSetup.svelte';
	import ApiView from '$lib/components/views/ApiView.svelte';
	import {
		getAgentRecipes,
		getSkillPrompt,
		type InstallPath
	} from '$lib/utils/agent-recipes';
	import { getSupabaseProjectRef, resolveAgentTargetContext } from '$lib/utils/agent-targets';
	import { normalizeAgentSlug, type AgentSlug } from '$lib/utils/agent-icons';

	export let open = false;
	/** Optional starting view — 'api' jumps straight to the REST panel. */
	export let initialView: 'agents' | 'api' = 'agents';
	export let onClose: () => void = () => {};

	const STORAGE_KEY = 'cojo:lastAgent';
	const PATH_STORAGE_KEY = 'cojo:lastPath';

	let agent: AgentSlug = 'claude-code';
	let view: 'agents' | 'api' = 'agents';
	let skillCopied = false;
	let path: InstallPath = 'cli';
	$: agentTarget = resolveAgentTargetContext({
		deploymentTarget: import.meta.env.PUBLIC_DEPLOYMENT_TARGET,
		supabaseUrl: import.meta.env.PUBLIC_SUPABASE_URL,
		supabaseAnonKey: import.meta.env.PUBLIC_SUPABASE_ANON_KEY,
		origin: typeof window !== 'undefined' ? window.location.origin : undefined,
		hostname: typeof window !== 'undefined' ? window.location.hostname : undefined
	});

	$: agentRecipes = getAgentRecipes(agent, agentTarget);
	$: availablePaths = agentRecipes.paths;
	// Snap path to an available one whenever the agent changes.
	$: if (!availablePaths.includes(path)) path = agentRecipes.default;
	$: recipe = agentRecipes.recipes[path] ?? agentRecipes.recipes[agentRecipes.default]!;
	$: showSetupPrompt = recipe.setupKind === 'automated-cli';
	// Prompt adapts to the agent's skill save location for CLI setup flows.
	$: skillPrompt = getSkillPrompt(agent, path, agentTarget);
	$: targetProjectRef =
		agentTarget.deploymentKind === 'supabase'
			? getSupabaseProjectRef(import.meta.env.PUBLIC_SUPABASE_URL)
			: null;

	function close() {
		onClose();
	}

	function handleBackdrop(event: MouseEvent) {
		if ((event.target as HTMLElement).classList.contains('agents-backdrop')) {
			close();
		}
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') close();
	}

	function handleAgentChange(next: AgentSlug) {
		agent = next;
		try {
			localStorage.setItem(STORAGE_KEY, agent);
		} catch {
			// localStorage may be unavailable (private mode) — silently ignore.
		}
	}

	function handlePathChange(next: InstallPath) {
		path = next;
		try {
			localStorage.setItem(PATH_STORAGE_KEY, next);
		} catch {
			// ignore
		}
	}

	function copySkillPrompt() {
		navigator.clipboard.writeText(skillPrompt);
		skillCopied = true;
		setTimeout(() => {
			skillCopied = false;
		}, 1500);
	}

	onMount(() => {
		try {
			const last = localStorage.getItem(STORAGE_KEY);
			if (last) {
				agent = normalizeAgentSlug(last);
				if (agent !== last) localStorage.setItem(STORAGE_KEY, agent);
			}
			const lastPath = localStorage.getItem(PATH_STORAGE_KEY) as InstallPath | null;
			if (lastPath === 'cli' || lastPath === 'mcp') path = lastPath;
		} catch {
			// ignore
		}
		view = initialView;
	});

	$: if (open) view = initialView;

	$: if (typeof document !== 'undefined') {
		document.body.style.overflow = open ? 'hidden' : '';
	}

	onDestroy(() => {
		if (typeof document !== 'undefined') {
			document.body.style.overflow = '';
		}
	});
</script>

<svelte:window on:keydown={handleKeydown} />

{#if open}
	<!-- svelte-ignore a11y-click-events-have-key-events -->
	<!-- svelte-ignore a11y-no-static-element-interactions -->
	<div class="agents-backdrop" on:click={handleBackdrop}>
		<div class="agents-modal" role="dialog" aria-modal="true" aria-label="Connect an agent">
			<div class="agents-header">
				<div>
					<h2>
						{#if view === 'api'}
							REST API
						{:else}
							Connect your AI assistant
						{/if}
					</h2>
					<p>
						{#if view === 'api'}
							Bearer-token REST endpoints for custom scripts, ChatGPT Actions, or any non-MCP
							client.
						{:else}
							Point your agent at coJournalist via the <code>cojo</code> CLI (one binary, works
							anywhere with a shell) or via MCP (for chat UIs without shell access).
						{/if}
					</p>
				</div>
				<button class="icon-btn" on:click={close} aria-label="Close">
					<X size={16} />
				</button>
			</div>

			<div class="agents-body">
				<div class="toolbar">
					{#if view === 'agents'}
						<AgentSelect value={agent} onChange={handleAgentChange} />
					{:else}
						<button
							type="button"
							class="toolbar-btn back"
							on:click={() => (view = 'agents')}
						>
							&larr; Back to agents
						</button>
					{/if}

					<div class="toolbar-actions">
						<a
							href="/docs#mcp"
							target="_blank"
							rel="noopener"
							class="toolbar-btn"
							aria-label="Open MCP docs in a new tab"
							title="How this works"
						>
							<Eye size={13} />
							<span>Docs</span>
						</a>
						<button
							type="button"
							class="toolbar-btn"
							class:active={view === 'api'}
							aria-pressed={view === 'api'}
							on:click={() => (view = view === 'api' ? 'agents' : 'api')}
							title="REST API reference"
						>
							<Code2 size={13} />
							<span>API</span>
						</button>
					</div>
				</div>

				{#if view === 'api'}
					<div class="api-body">
						<ApiView />
					</div>
				{:else}
					{#if availablePaths.length > 1}
						<div class="path-tabs" role="tablist" aria-label="Connection path">
							{#each availablePaths as p}
								<button
									type="button"
									role="tab"
									aria-selected={path === p}
									class="path-tab"
									class:active={path === p}
									on:click={() => handlePathChange(p)}
								>
									<span class="path-label">{p === 'cli' ? 'CLI' : 'MCP'}</span>
									{#if p === agentRecipes.default}
										<span class="path-badge">Recommended</span>
									{/if}
								</button>
							{/each}
						</div>
					{/if}

					{#if showSetupPrompt}
						<!-- 1-click setup: the whole walkthrough lives in the prompt. -->
						<section class="skill">
							<div class="skill-head">
								<span class="skill-eyebrow">Step 1 · 1-click setup</span>
								<h3>Paste this into your first message</h3>
								<div class="target-summary">
									<span>Active target</span>
									<code>{agentTarget.apiBaseUrl}</code>
									{#if targetProjectRef}
										<small>Project ref: {targetProjectRef}</small>
									{/if}
								</div>
								<p>
									It tells your AI to fetch <code>skill.md</code>, install the
									<code>cojo CLI</code>, and verify the connection. The prompt tells the agent
									to have you save a <code>cj_…</code> API key locally — click
									<strong>API</strong> above to create one.
								</p>
							</div>
							<div class="skill-prompt">
								<pre><code>{skillPrompt}</code></pre>
								<button class="copy-btn" on:click={copySkillPrompt} aria-label="Copy prompt">
									{#if skillCopied}
										<Check size={13} /><span>Copied</span>
									{:else}
										<Copy size={13} /><span>Copy</span>
									{/if}
								</button>
							</div>
							<div class="skill-actions">
								<a
									class="skill-action"
									href={agentTarget.skillUrl}
									download="cojournalist-skill.md"
									target="_blank"
									rel="noopener"
								>
									<Download size={13} />
									<span>Download skill.md</span>
								</a>
								<span class="skill-action-hint">
									Prompt is dynamic per agent. <code>skill.md</code> is the same for every
									agent — it's the product manual.
								</span>
							</div>
						</section>

						<div class="divider"></div>
					{/if}

					<section class="fallback">
						<span class="skill-eyebrow">
							{showSetupPrompt ? 'Step 2 · Reference' : 'Manual setup'}
						</span>
						<p class="fallback-hint">
							{#if showSetupPrompt}
								The prompt above handles this automatically. These are the raw install +
								config commands for reference, in case you or the agent want to step through
								them manually.
							{:else}
								This runtime needs a manual connector or config step. Follow the steps below;
								OAuth handles sign-in when the runtime connects to coJournalist.
							{/if}
						</p>
						<AgentSetup {recipe} />
					</section>
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	.agents-backdrop {
		position: fixed;
		inset: 0;
		z-index: 100;
		background: rgba(32, 26, 42, 0.65);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1.5rem;
		animation: backdropFade 150ms ease-out;
	}

	@keyframes backdropFade {
		from { opacity: 0; }
		to   { opacity: 1; }
	}

	.agents-modal {
		width: 100%;
		max-width: 820px;
		max-height: calc(100vh - 3rem);
		display: flex;
		flex-direction: column;
		background: var(--color-surface-alt);
		border: 1px solid var(--color-border);
		box-shadow: var(--shadow-modal);
		overflow-y: auto;
		animation: modalPop 300ms cubic-bezier(0.4, 0, 0.2, 1);
		font-family: var(--font-body);
	}

	@keyframes modalPop {
		from { opacity: 0; transform: translateY(8px); }
		to   { opacity: 1; transform: translateY(0); }
	}

	.agents-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		padding: 1.25rem 1.5rem 1rem;
		border-bottom: 1px solid var(--color-border);
	}

	.agents-header h2 {
		font-family: var(--font-display);
		font-size: 1.5rem;
		font-weight: 600;
		color: var(--color-ink);
		margin: 0 0 0.25rem 0;
		letter-spacing: -0.01em;
	}

	.agents-header p {
		font-size: 0.8125rem;
		font-weight: 300;
		color: var(--color-ink-muted);
		margin: 0;
		line-height: 1.55;
	}

	.agents-header code {
		font-family: var(--font-mono);
		font-size: 0.75rem;
		padding: 0.0625rem 0.3125rem;
		background: var(--color-surface);
		color: var(--color-ink);
		border: 1px solid var(--color-border);
	}

	.icon-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		background: transparent;
		border: 1px solid transparent;
		color: var(--color-ink-subtle);
		cursor: pointer;
		flex-shrink: 0;
		transition: background 150ms ease, color 150ms ease, border-color 150ms ease;
	}
	.icon-btn:hover {
		background: var(--color-surface);
		color: var(--color-ink);
		border-color: var(--color-border);
	}

	.agents-body {
		padding: 1.25rem 1.5rem 1.5rem;
	}

	.toolbar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 1.25rem;
	}

	.toolbar-actions {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		margin-left: auto;
	}

	.toolbar-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.4375rem 0.75rem;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--color-ink-muted);
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		text-decoration: none;
		cursor: pointer;
		transition: border-color 150ms ease, color 150ms ease, background 150ms ease;
	}
	.toolbar-btn:hover {
		border-color: var(--color-primary);
		color: var(--color-primary);
	}
	.toolbar-btn.active {
		background: var(--color-primary-soft);
		border-color: var(--color-primary);
		color: var(--color-primary-deep);
	}
	.toolbar-btn.back {
		color: var(--color-primary);
		font-weight: 500;
	}

	.divider {
		height: 1px;
		background: var(--color-border);
		margin: 1.25rem 0;
	}

	.path-tabs {
		display: inline-flex;
		gap: 0;
		margin-bottom: 1rem;
		border: 1px solid var(--color-border);
	}
	.path-tab {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.4375rem 0.875rem;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--color-ink-muted);
		background: var(--color-surface-alt);
		border: none;
		border-right: 1px solid var(--color-border);
		cursor: pointer;
		transition: background 150ms ease, color 150ms ease;
	}
	.path-tab:last-child { border-right: none; }
	.path-tab:hover:not(.active) {
		color: var(--color-ink);
		background: var(--color-bg);
	}
	.path-tab.active {
		background: var(--color-ink);
		color: var(--color-bg);
	}
	.path-badge {
		font-family: var(--font-mono);
		font-size: 0.5625rem;
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--color-secondary);
		background: var(--color-secondary-soft);
		border: 1px solid var(--color-secondary);
		padding: 0.0625rem 0.3125rem;
	}
	.path-tab.active .path-badge {
		color: var(--color-bg);
		background: var(--color-secondary);
		border-color: var(--color-secondary);
	}
	.path-tab:not(.active) .path-badge {
		color: var(--color-ink-muted);
		background: var(--color-surface);
		border-color: var(--color-border-strong);
	}

	.skill-actions {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		margin-top: 0.625rem;
		flex-wrap: wrap;
	}
	.skill-action {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.4375rem 0.75rem;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--color-primary-deep);
		background: var(--color-primary-soft);
		border: 1px solid var(--color-primary);
		text-decoration: none;
		transition: background 150ms ease;
	}
	.skill-action:hover {
		background: var(--color-bg);
	}
	.skill-action-hint {
		font-size: 0.8125rem;
		font-weight: 300;
		color: var(--color-ink-muted);
		line-height: 1.5;
	}
	.skill-action-hint code {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		padding: 0.0625rem 0.3125rem;
		background: var(--color-surface);
		color: var(--color-ink);
		border: 1px solid var(--color-border);
	}

	.skill-eyebrow {
		display: inline-block;
		font-family: var(--font-mono);
		font-size: 0.625rem;
		font-weight: 500;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--color-secondary);
		margin-bottom: 0.5rem;
	}

	.fallback {
		margin-top: 0.25rem;
	}

	.fallback-hint {
		font-size: 0.8125rem;
		font-weight: 300;
		color: var(--color-ink-muted);
		line-height: 1.55;
		margin: 0 0 0.875rem 0;
	}

	.skill-head h3 {
		font-family: var(--font-display);
		font-size: 1.125rem;
		font-weight: 600;
		color: var(--color-ink);
		margin: 0 0 0.25rem 0;
		letter-spacing: -0.01em;
	}
	.target-summary {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: center;
		gap: 0.5rem;
		margin: 0 0 0.625rem;
		padding: 0.5rem 0.625rem;
		background: var(--color-surface);
		border: 1px solid var(--color-border);
	}
	.target-summary span,
	.target-summary small {
		font-size: 0.6875rem;
		font-weight: 500;
		color: var(--color-ink-subtle);
	}
	.target-summary code {
		min-width: 0;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		color: var(--color-ink);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.skill-head p {
		font-size: 0.875rem;
		font-weight: 300;
		color: var(--color-ink-muted);
		margin: 0 0 0.625rem 0;
		line-height: 1.55;
	}
	.skill-head code {
		font-family: var(--font-mono);
		font-size: 0.75rem;
		padding: 0.0625rem 0.3125rem;
		background: var(--color-surface);
		color: var(--color-ink);
		border: 1px solid var(--color-border);
	}

	.skill-prompt {
		position: relative;
	}
	.skill-prompt pre {
		margin: 0;
		padding: 0.875rem 1rem;
		padding-right: 5.25rem;
		background: var(--color-ink);
		color: var(--color-bg);
		font-family: var(--font-mono);
		font-size: 0.75rem;
		line-height: 1.55;
		overflow-x: auto;
		white-space: pre-wrap;
		word-break: break-word;
	}
	.copy-btn {
		position: absolute;
		top: 0.5rem;
		right: 0.5rem;
		display: inline-flex;
		align-items: center;
		gap: 0.3125rem;
		padding: 0.3125rem 0.625rem;
		font-family: var(--font-mono);
		font-size: 0.625rem;
		font-weight: 500;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--color-bg);
		background: rgba(245, 239, 227, 0.12);
		border: 1px solid rgba(245, 239, 227, 0.3);
		cursor: pointer;
		transition: background 150ms ease, border-color 150ms ease;
		white-space: nowrap;
	}
	.copy-btn:hover {
		background: rgba(245, 239, 227, 0.22);
		border-color: rgba(245, 239, 227, 0.5);
	}

	.api-body {
		margin-top: 0.25rem;
	}
</style>

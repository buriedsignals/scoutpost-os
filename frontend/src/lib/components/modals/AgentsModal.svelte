<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { X, Eye, Copy, Check, Code2 } from 'lucide-svelte';
	import AgentSelect from '$lib/components/ui/AgentSelect.svelte';
	import AgentSetup from '$lib/components/ui/AgentSetup.svelte';
	import ApiView from '$lib/components/views/ApiView.svelte';
	import {
		getAgentRecipes,
		getSkillPrompt,
		type InstallPath
	} from '$lib/utils/agent-recipes';
	import { resolveAgentTargetContext } from '$lib/utils/agent-targets';
	import { getAgent, normalizeAgentSlug, type AgentSlug } from '$lib/utils/agent-icons';

	export let open = false;
	/** Optional starting view — 'api' jumps straight to the REST panel. */
	export let initialView: 'agents' | 'api' = 'agents';
	/** When true, locks the modal to the API view — hides agents navigation. */
	export let apiOnly = false;
	export let onClose: () => void = () => {};

	const STORAGE_KEY = 'scout:lastAgent';
	const PATH_STORAGE_KEY = 'scout:lastPath';

	let agent: AgentSlug = 'claude-code';
	let view: 'agents' | 'api' = 'agents';
	let skillCopied = false;
	let copyError = false;
	let path: InstallPath = 'cli';
	$: agentTarget = resolveAgentTargetContext({
		deploymentTarget: import.meta.env.PUBLIC_DEPLOYMENT_TARGET,
		supabaseUrl: import.meta.env.PUBLIC_SUPABASE_URL,
		supabaseAnonKey: import.meta.env.PUBLIC_SUPABASE_ANON_KEY,
		origin: typeof window !== 'undefined' ? window.location.origin : undefined,
		hostname: typeof window !== 'undefined' ? window.location.hostname : undefined
	});

	$: agentRecipes = getAgentRecipes(agent, agentTarget);
	$: selectedAgent = getAgent(agent);
	$: availablePaths = agentRecipes.paths;
	// Snap path to an available one whenever the agent changes.
	$: if (!availablePaths.includes(path)) path = agentRecipes.default;
	$: recipe = agentRecipes.recipes[path] ?? agentRecipes.recipes[agentRecipes.default]!;
	$: showSetupPrompt = recipe.setupKind === 'automated-cli';
	$: skillPrompt = getSkillPrompt(agent, path, agentTarget);

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

	async function copySkillPrompt() {
		copyError = false;
		try {
			await navigator.clipboard.writeText(skillPrompt);
			skillCopied = true;
			setTimeout(() => {
				skillCopied = false;
			}, 1500);
		} catch {
			skillCopied = false;
			copyError = true;
		}
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

	$: if (open) view = apiOnly ? 'api' : initialView;

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
							Connect an agent
						{/if}
					</h2>
					<p>
						{#if view === 'api'}
							Bearer-token REST endpoints for custom scripts, ChatGPT Actions, or any non-MCP
							client.
						{:else}
							Choose your assistant. We&rsquo;ll show the fastest supported setup.
						{/if}
					</p>
				</div>
				<button class="icon-btn" on:click={close} aria-label="Close">
					<X size={16} />
				</button>
			</div>

			<div class="agents-body">
				{#if view === 'agents' || !apiOnly}
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
					</div>
				{/if}

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
						<!-- One primary action; manual commands stay available on demand. -->
						<section class="skill">
							<div class="skill-head">
								<span class="skill-eyebrow">Recommended · CLI</span>
								<h3>Let {selectedAgent.name} connect itself</h3>
								<p>
									Paste one short prompt into {selectedAgent.name}. It installs <code>scout</code>,
									keeps your API key on this computer, and checks the connection.
								</p>
								{#if agentTarget.deploymentKind === 'supabase'}
									<p class="target-note">Connecting to <code>{agentTarget.appUrl}</code></p>
								{/if}
							</div>
							<button type="button" class="primary-copy" on:click={copySkillPrompt}>
								{#if skillCopied}
									<Check size={15} /><span>Setup prompt copied</span>
								{:else}
									<Copy size={15} /><span>Copy setup prompt</span>
								{/if}
							</button>
							{#if copyError}
								<div class="copy-fallback" role="alert">
									<p>Clipboard access is blocked. Select and copy this prompt:</p>
									<textarea readonly value={skillPrompt} on:focus={(event) => event.currentTarget.select()}></textarea>
								</div>
							{/if}
							<p class="verification-line">
								Test it: ask
								<q>Run <code>scout scouts list</code> and tell me what I&rsquo;m monitoring.</q>
							</p>
						</section>

						<details class="manual-details">
							<summary>Manual CLI setup</summary>
							<div class="manual-content"><AgentSetup {recipe} /></div>
						</details>
					{:else}
						<section class="fallback">
							<span class="skill-eyebrow">Connect with {path.toUpperCase()}</span>
							<AgentSetup {recipe} />
						</section>
					{/if}

					<div class="agents-footer">
						<a href={path === 'cli' ? '/docs#cli' : '/docs#mcp'} target="_blank" rel="noopener" class="footer-link">
							<Eye size={13} /><span>Full connection guide</span>
						</a>
						<button type="button" class="footer-link api-task" on:click={() => (view = 'api')}>
							<Code2 size={13} /><span>API keys &amp; REST</span><span aria-hidden="true">&rarr;</span>
						</button>
					</div>
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
		background: var(--modal-backdrop);
		backdrop-filter: blur(8px);
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
		border-radius: var(--radius-xl);
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
		font-weight: 500;
		color: var(--color-ink-muted);
		margin: 0;
		line-height: 1.55;
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
		border-radius: var(--radius-md);
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
		margin-bottom: 1.25rem;
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
		border-radius: var(--radius-md);
	}
	.toolbar-btn:hover {
		border-color: var(--color-border-strong);
		color: var(--color-ink);
		background: var(--color-surface);
	}
	.toolbar-btn.back {
		color: var(--color-primary);
		font-weight: 500;
	}

	.path-tabs {
		display: inline-flex;
		gap: 0;
		margin-bottom: 1rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		overflow: hidden;
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
		background: oklch(0.48 0.035 205 / 34%);
		color: var(--color-ink);
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
		border-radius: var(--radius-pill);
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

	.skill {
		display: grid;
		gap: 1rem;
		padding: 1.25rem;
		background: linear-gradient(145deg, var(--color-surface), var(--color-surface-alt));
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-xl);
		box-shadow: var(--shadow-md);
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

	.skill-head h3 {
		font-family: var(--font-display);
		font-size: 1.125rem;
		font-weight: 600;
		color: var(--color-ink);
		margin: 0 0 0.25rem 0;
		letter-spacing: -0.01em;
	}
	.skill-head p {
		font-size: 0.875rem;
		font-weight: 500;
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
		border-radius: var(--radius-sm);
	}
	.skill-head .target-note {
		margin-bottom: 0;
		font-size: 0.75rem;
		color: var(--color-ink-subtle);
	}

	.primary-copy {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		width: fit-content;
		min-height: 2.5rem;
		padding: 0.625rem 1rem;
		font: inherit;
		font-size: 0.8125rem;
		font-weight: 650;
		color: var(--color-bg);
		background: var(--color-primary);
		border: 1px solid var(--color-primary);
		border-radius: var(--radius-lg);
		cursor: pointer;
		box-shadow: 0 8px 24px oklch(0.18 0.025 220 / 28%);
		transition: transform 150ms ease, filter 150ms ease, box-shadow 150ms ease;
	}
	.primary-copy:hover {
		filter: brightness(1.08);
		transform: translateY(-1px);
		box-shadow: 0 10px 28px oklch(0.18 0.025 220 / 34%);
	}
	.primary-copy:active {
		transform: translateY(0);
	}
	.copy-fallback { display: grid; gap: 0.5rem; }
	.copy-fallback p { margin: 0; color: var(--color-warning); font-size: 0.75rem; }
	.copy-fallback textarea { width: 100%; min-height: 8rem; resize: vertical; padding: 0.75rem; border: 1px solid var(--color-border-strong); border-radius: var(--radius-md); background: var(--color-bg); color: var(--color-ink); font-family: var(--font-mono); font-size: 0.6875rem; line-height: 1.5; }

	.verification-line {
		margin: 0;
		padding-top: 0.875rem;
		border-top: 1px solid var(--color-border);
		font-size: 0.75rem;
		font-weight: 500;
		line-height: 1.55;
		color: var(--color-ink-muted);
	}
	.verification-line code {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		color: var(--color-ink);
	}

	.manual-details {
		margin-top: 0.75rem;
		border-bottom: 1px solid var(--color-border);
	}
	.manual-details summary {
		width: fit-content;
		padding: 0.625rem 0;
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--color-ink-muted);
		cursor: pointer;
		transition: color 150ms ease;
	}
	.manual-details summary:hover {
		color: var(--color-ink);
	}
	.manual-content {
		padding: 0.25rem 0 1rem;
	}
	:global(.manual-details .verify) {
		display: none;
	}

	.agents-footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		margin-top: 1rem;
		padding-top: 1rem;
		border-top: 1px solid var(--color-border);
	}
	.footer-link {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0;
		font: inherit;
		font-size: 0.75rem;
		font-weight: 550;
		color: var(--color-ink-muted);
		background: transparent;
		border: 0;
		text-decoration: none;
		cursor: pointer;
		transition: color 150ms ease;
	}
	.footer-link:hover {
		color: var(--color-ink);
	}
	.api-task {
		color: var(--color-primary);
	}

	.api-body {
		margin-top: 0.25rem;
	}
</style>

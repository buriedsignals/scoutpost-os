<script lang="ts">
	import { onMount } from 'svelte';
	import { Copy, Check, Plus, Trash2, ExternalLink, Key } from 'lucide-svelte';
	import { apiClient } from '$lib/api-client';
	import {
		HOSTED_AGENT_TARGET,
		getSupabaseProjectRef,
		isHostedScoutpostHost
	} from '$lib/utils/agent-targets';
	import * as m from '$lib/paraglide/messages';

	// --- State ---
	type ApiKey = {
		key_id: string;
		key_prefix: string;
		name: string;
		created_at: string;
		last_used_at: string | null;
	};

	let keys: ApiKey[] = [];
	let loading = true;
	let newKeyName = '';
	let creatingKey = false;
	let newlyCreatedKey: string | null = null;
	let copiedId: string | null = null;
	let copiedAgent = false;
	let revokeConfirmId: string | null = null;

	const isSupabase = import.meta.env.PUBLIC_DEPLOYMENT_TARGET === 'supabase';
	const supabaseUrl = (import.meta.env.PUBLIC_SUPABASE_URL ?? '').replace(/\/$/, '');
	const origin = typeof window !== 'undefined' ? window.location.origin : '';
	const hostedBroker =
		typeof window !== 'undefined' &&
		isHostedScoutpostHost(window.location.hostname);
	const apiBase = hostedBroker
		? HOSTED_AGENT_TARGET.apiBaseUrl
		: isSupabase
			? `${supabaseUrl}/functions/v1`
			: `${origin}/api/v1`;
	const specUrl = hostedBroker
		? `${HOSTED_AGENT_TARGET.apiBaseUrl}/openapi-spec`
		: isSupabase
			? `${supabaseUrl}/functions/v1/openapi-spec`
			: `${origin}/api/openapi.json`;
	const projectRef = isSupabase ? getSupabaseProjectRef(supabaseUrl) : null;
	const targetLabel = hostedBroker
		? 'scoutpost.ai'
		: projectRef
			? `Supabase project ${projectRef}`
			: isSupabase
				? 'Supabase project not configured'
				: origin;
	// Swagger UI: Supabase has no auto-generated /api/docs, so we serve our own
	// SvelteKit route (/swagger) that loads swagger-ui-dist from CDN and points at specUrl.
	// Route name deliberately avoids the `/api` prefix so the Vite dev proxy doesn't
	// catch it and forward to the FastAPI backend.
	const swaggerUrl = hostedBroker || isSupabase ? '/swagger' : '/api/docs';

	const AGENT_INSTRUCTIONS = `Active target: ${targetLabel}
Base URL: ${apiBase}
API Spec: ${specUrl}
Auth: Bearer <your-api-key>`;

	// --- Lifecycle ---
	onMount(loadKeys);

	async function loadKeys() {
		loading = true;
		try {
			const result = await apiClient.listApiKeys();
			keys = result.keys;
		} catch {
			keys = [];
		} finally {
			loading = false;
		}
	}

	async function createKey() {
		if (creatingKey) return;
		creatingKey = true;
		try {
			const result = await apiClient.createApiKey(newKeyName || undefined);
			newlyCreatedKey = result.key;
			newKeyName = '';
			await loadKeys();
		} catch (err: any) {
			alert(err.message || 'Failed to create key');
		} finally {
			creatingKey = false;
		}
	}

	async function revokeKey(keyId: string) {
		try {
			await apiClient.revokeApiKey(keyId);
			revokeConfirmId = null;
			newlyCreatedKey = null;
			await loadKeys();
		} catch (err: any) {
			alert(err.message || 'Failed to revoke key');
		}
	}

	function copyToClipboard(text: string, id: string) {
		navigator.clipboard.writeText(text);
		copiedId = id;
		setTimeout(() => { copiedId = null; }, 2000);
	}

	function copyAgentInstructions() {
		navigator.clipboard.writeText(AGENT_INSTRUCTIONS);
		copiedAgent = true;
		setTimeout(() => { copiedAgent = false; }, 2000);
	}

	function formatDate(iso: string): string {
		return new Date(iso).toLocaleDateString(undefined, {
			year: 'numeric', month: 'short', day: 'numeric'
		});
	}

	function formatRelative(iso: string | null): string {
		if (!iso) return m.api_neverUsed();
		const diff = Date.now() - new Date(iso).getTime();
		const mins = Math.floor(diff / 60000);
		if (mins < 60) return m.api_lastUsed({ time: `${mins}m ago` });
		const hours = Math.floor(mins / 60);
		if (hours < 24) return m.api_lastUsed({ time: `${hours}h ago` });
		const days = Math.floor(hours / 24);
		return m.api_lastUsed({ time: `${days}d ago` });
	}
</script>

<div class="api-view">
	<div class="api-content">
		<!-- Section A: Getting Started -->
		<div class="form-group">
			<p class="field-label">{m.api_gettingStarted()}</p>
			<div class="agent-block">
				<div class="agent-block-header">
					<span class="agent-label">{m.api_agentInstructions()}</span>
					<button class="copy-btn" on:click={copyAgentInstructions}>
						{#if copiedAgent}
							<Check size={14} />
							<span>{m.api_copied()}</span>
						{:else}
							<Copy size={14} />
							<span>{m.api_copy()}</span>
						{/if}
					</button>
				</div>
				<div class="target-summary">
					<span>Active API target</span>
					<code>{apiBase}</code>
					{#if projectRef}
						<small>Project ref: {projectRef}</small>
					{/if}
				</div>
				<pre class="agent-code">{AGENT_INSTRUCTIONS}</pre>
			</div>
		</div>

		<!-- Section B: API Keys -->
		<div class="form-group">
			<div class="field-label-row">
				<p class="field-label">{m.api_keys()}</p>
				{#if keys.length >= 5}
					<span class="max-keys-badge">{m.api_maxKeys()}</span>
				{/if}
			</div>

			<!-- New key created banner -->
			{#if newlyCreatedKey}
				<div class="new-key-banner">
					<div class="new-key-banner-icon">
						<Key size={16} />
					</div>
					<div class="new-key-banner-content">
						<p class="new-key-warning">{m.api_keyCreated()}</p>
						<div class="new-key-value-row">
							<code class="new-key-value">{newlyCreatedKey}</code>
							<button
								class="copy-btn"
								on:click={() => copyToClipboard(newlyCreatedKey || '', '__new__')}
							>
								{#if copiedId === '__new__'}
									<Check size={14} />
									<span>{m.api_copied()}</span>
								{:else}
									<Copy size={14} />
									<span>{m.api_copy()}</span>
								{/if}
							</button>
						</div>
					</div>
				</div>
			{/if}

			<!-- Create key form -->
			{#if keys.length < 5}
				<form class="create-key-form" on:submit|preventDefault={createKey}>
					<input
						type="text"
						class="key-name-input"
						placeholder={m.api_keyNamePlaceholder()}
						bind:value={newKeyName}
						maxlength="64"
					/>
					<button type="submit" class="create-key-btn" disabled={creatingKey}>
						<Plus size={16} />
						{m.api_createKey()}
					</button>
				</form>
			{/if}

			<!-- Key list -->
			{#if loading}
				<div class="keys-empty">
					<span class="loading-text">Loading...</span>
				</div>
			{:else if keys.length === 0}
				<div class="keys-empty">
					<Key size={20} class="empty-icon" />
					<span>{m.api_noKeys()}</span>
				</div>
			{:else}
				<div class="keys-list">
					{#each keys as key (key.key_id)}
						<div class="key-row">
							<div class="key-info">
								<span class="key-name">{key.name}</span>
								<code class="key-prefix">{key.key_prefix}...</code>
							</div>
							<div class="key-meta">
								<span class="key-date">{formatDate(key.created_at)}</span>
								<span class="key-usage">{formatRelative(key.last_used_at)}</span>
							</div>
							<div class="key-actions">
								{#if revokeConfirmId === key.key_id}
									<button class="revoke-confirm-btn" on:click={() => revokeKey(key.key_id)}>
										{m.api_revoke()}?
									</button>
									<button class="cancel-btn" on:click={() => revokeConfirmId = null}>
										Cancel
									</button>
								{:else}
									<button
										class="revoke-btn"
										on:click={() => revokeConfirmId = key.key_id}
										title={m.api_revokeConfirm()}
									>
										<Trash2 size={14} />
									</button>
								{/if}
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>

		<!-- Section C: API Reference -->
		<div class="form-group">
			<p class="field-label">{m.api_reference()}</p>
			<div class="ref-links">
				<a href={swaggerUrl} target="_blank" rel="noopener noreferrer" class="ref-link">
					<ExternalLink size={16} />
					<div>
						<span class="ref-link-title">{m.api_reference()}</span>
						<span class="ref-link-desc">Interactive Swagger UI</span>
					</div>
				</a>
				<a href={specUrl} target="_blank" rel="noopener noreferrer" class="ref-link">
					<ExternalLink size={16} />
					<div>
						<span class="ref-link-title">{m.api_openApiSpec()}</span>
						<span class="ref-link-desc">JSON spec for AI agents</span>
					</div>
				</a>
			</div>
		</div>
	</div>
</div>

<style>
	.api-view {
		height: 100%;
		overflow-y: auto;
		padding: 1.5rem;
	}

	.api-content {
		max-width: 640px;
		margin: 0 auto;
	}

	/* Form groups — shared with scout creation views */
	.form-group {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		margin-bottom: 1rem;
	}

	.field-label {
		display: block;
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--color-ink);
		margin: 0;
	}

	.field-label-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.max-keys-badge {
		font-size: 0.6875rem;
		color: var(--color-ink-subtle);
		font-weight: 500;
	}

	/* Agent instructions block */
	.agent-block {
		background: var(--color-surface-alt);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		overflow: hidden;
	}

	.agent-block-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.625rem 0.875rem;
		border-bottom: 1px solid var(--color-border);
	}

	.agent-label {
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--color-ink);
	}

	.target-summary {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: center;
		gap: 0.5rem;
		padding: 0.625rem 0.875rem;
		border-bottom: 1px solid var(--color-border);
		background: var(--color-surface);
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

	.agent-code {
		margin: 0;
		padding: 0.875rem;
		font-size: 0.8125rem;
		line-height: 1.6;
		color: var(--color-foreground);
		background: color-mix(in oklab, var(--color-background) 90%, black);
		font-family: var(--font-mono);
		white-space: pre;
		overflow-x: auto;
	}

	/* Copy button */
	.copy-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.25rem 0.5rem;
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--color-ink-muted);
		background: transparent;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.copy-btn:hover {
		background: var(--color-surface-hover);
		color: var(--color-ink);
		transform: translateY(-1px);
	}

	/* New key banner */
	.new-key-banner {
		display: flex;
		gap: 0.75rem;
		padding: 0.875rem;
		background: color-mix(in oklab, var(--color-pond) 12%, var(--color-card));
		border: 1px solid color-mix(in oklab, var(--color-pond) 36%, var(--color-border));
		border-radius: var(--radius-lg);
		margin-bottom: 0.75rem;
	}

	.new-key-banner-icon {
		color: var(--color-moonlight);
		flex-shrink: 0;
		margin-top: 0.125rem;
	}

	.new-key-banner-content {
		flex: 1;
		min-width: 0;
	}

	.new-key-warning {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--color-foreground);
		margin: 0 0 0.5rem;
	}

	.new-key-value-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.new-key-value {
		font-size: 0.8125rem;
		font-family: var(--font-mono);
		color: var(--color-ink);
		background: color-mix(in oklab, var(--color-background) 78%, black);
		padding: 0.25rem 0.5rem;
		border-radius: var(--radius-sm);
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* Create key form */
	.create-key-form {
		display: flex;
		gap: 0.5rem;
		margin-bottom: 0.75rem;
	}

	.key-name-input {
		flex: 1;
		padding: 0.5rem 0.75rem;
		font-size: 0.8125rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		background: var(--color-surface-alt);
		color: var(--color-ink);
		outline: none;
		transition: border-color 0.15s ease;
	}

	.key-name-input:focus {
		border-color: var(--color-ring);
		box-shadow: 0 0 0 3px color-mix(in oklab, var(--color-ring) 18%, transparent);
	}

	.key-name-input::placeholder {
		color: var(--color-ink-subtle);
	}

	.create-key-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.5rem 0.875rem;
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--primary-foreground);
		background: var(--color-primary);
		border: none;
		border-radius: var(--radius-sm);
		cursor: pointer;
		white-space: nowrap;
		transition: all 0.15s ease;
	}

	.create-key-btn:hover:not(:disabled) {
		transform: translateY(-1px);
		box-shadow: 0 10px 24px -14px color-mix(in oklab, var(--color-primary) 64%, transparent);
	}

	.create-key-btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	/* Key list */
	.keys-list {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		overflow: hidden;
	}

	.key-row {
		display: flex;
		align-items: center;
		gap: 1rem;
		padding: 0.75rem 0.875rem;
		background: var(--color-surface-alt);
		border-bottom: 1px solid var(--color-surface);
	}

	.key-row:last-child {
		border-bottom: none;
	}

	.key-info {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.key-name {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--color-ink);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.key-prefix {
		font-size: 0.75rem;
		font-family: var(--font-mono);
		color: var(--color-ink-subtle);
		white-space: nowrap;
	}

	.key-meta {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 0.125rem;
		flex-shrink: 0;
	}

	.key-date {
		font-size: 0.6875rem;
		color: var(--color-ink-subtle);
		white-space: nowrap;
	}

	.key-usage {
		font-size: 0.6875rem;
		color: var(--color-ink-subtle);
		white-space: nowrap;
	}

	.key-actions {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		flex-shrink: 0;
	}

	.revoke-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border: none;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--color-ink-subtle);
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.revoke-btn:hover {
		background: color-mix(in oklab, var(--color-error) 10%, transparent);
		color: var(--color-error);
	}

	.revoke-confirm-btn {
		padding: 0.25rem 0.5rem;
		font-size: 0.6875rem;
		font-weight: 600;
		color: var(--color-surface-alt);
		background: var(--color-error);
		border: none;
		border-radius: var(--radius-sm);
		cursor: pointer;
		transition: background 0.15s ease;
	}

	.revoke-confirm-btn:hover {
		background: var(--color-error);
	}

	.cancel-btn {
		padding: 0.25rem 0.5rem;
		font-size: 0.6875rem;
		font-weight: 500;
		color: var(--color-ink-muted);
		background: transparent;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		cursor: pointer;
	}

	/* Empty state */
	.keys-empty {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		padding: 2rem;
		color: var(--color-ink-subtle);
		font-size: 0.8125rem;
		border: 1px dashed var(--color-border);
		border-radius: var(--radius-lg);
	}

	.keys-empty :global(.empty-icon) {
		color: var(--color-border-strong);
	}

	.loading-text {
		color: var(--color-ink-subtle);
	}

	/* Reference links */
	.ref-links {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.ref-link {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.75rem 0.875rem;
		background: var(--color-surface-alt);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		text-decoration: none;
		color: var(--color-ink);
		transition: all 0.15s ease;
	}

	.ref-link:hover {
		border-color: var(--color-border-strong);
		background: var(--color-surface-hover);
		transform: translateY(-1px);
		box-shadow: var(--shadow-md);
	}

	.ref-link div {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}

	.ref-link-title {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--color-ink);
	}

	.ref-link-desc {
		font-size: 0.6875rem;
		color: var(--color-ink-subtle);
	}
</style>

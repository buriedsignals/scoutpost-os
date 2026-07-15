<script lang="ts">
	import { X, ExternalLink, Trash2 } from 'lucide-svelte';
	import { marked } from 'marked';
	import DOMPurify from 'dompurify';
	import Spinner from '$lib/components/ui/Spinner.svelte';
	import { DRAWER_TABS, DEFAULT_TAB, type DrawerTab } from '$lib/utils/workspace-tabs';
	import { cleanUnitStatement, getUnitTypeStyle } from '$lib/utils/units';
	import type { Unit } from '$lib/types/workspace';

	export let unit: Unit | null;
	export let open: boolean;
	export let loading = false;
	export let actionLoading: 'verify' | 'reject' | null = null;
	export let confirmingDelete = false;
	export let deleting = false;
	export let onClose: () => void = () => {};
	export let onVerify: (id: string) => void = () => {};
	export let onReject: (id: string) => void = () => {};
	export let onRequestDelete: (id: string) => void = () => {};
	export let onCancelDelete: (id: string) => void = () => {};
	export let onConfirmDelete: (id: string) => void = () => {};

	let activeTab: DrawerTab = DEFAULT_TAB;

	// When a new unit is loaded, reset to the default tab.
	let lastUnitId: string | null = null;
	$: if (unit && unit.id !== lastUnitId) {
		lastUnitId = unit.id;
		activeTab = DEFAULT_TAB;
	}

	// --- Derived visuals ---

	$: typeKey = (unit?.unit_type ?? '').toUpperCase();

	$: typeStyle = getUnitTypeStyle(typeKey);

	$: verified = unit?.verification?.verified === true;

	function formatOccurred(iso: string | null | undefined): string | null {
		if (!iso) return null;
		const d = new Date(iso);
		if (!Number.isFinite(d.getTime())) return null;
		return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
	}

	function formatExtractedRel(iso: string | null | undefined): string | null {
		if (!iso) return null;
		const then = new Date(iso).getTime();
		if (!Number.isFinite(then)) return null;
		const seconds = Math.floor((Date.now() - then) / 1000);
		if (seconds < 60) return `${Math.max(seconds, 0)}s ago`;
		if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
		if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
		const days = Math.floor(seconds / 86400);
		return days === 1 ? '1d ago' : `${days}d ago`;
	}

	$: occurredLabel = formatOccurred(unit?.occurred_at);
	$: extractedLabel = formatExtractedRel(unit?.extracted_at);

	function truncate(text: string | null | undefined, limit: number): string {
		if (!text) return '';
		if (text.length <= limit) return text;
		return text.slice(0, limit).trimEnd() + '…';
	}

	$: cleanedStatement = cleanUnitStatement(unit?.statement);
	$: titleText = truncate(cleanedStatement, 120);

	$: sourceDomain = unit?.source?.domain ?? '';
	$: sourceUrl = unit?.source?.url ?? '';

	$: entityCount = unit?.entities?.length ?? 0;
	// Reflections are fetched separately; placeholder count of 0 in this component.
	const reflectionCount = 0;

	function renderMarkdown(text: string | null | undefined): string {
		if (!text) return '';
		try {
			const html = marked.parse(text, { async: false }) as string;
			return DOMPurify.sanitize(html);
		} catch {
			return DOMPurify.sanitize(text);
		}
	}

	$: statementHtml = renderMarkdown(cleanedStatement);
	$: contextHtml = renderMarkdown(unit?.context_excerpt);

	const TAB_LABELS: Record<DrawerTab, string> = {
		content: 'Content',
		entities: 'Entities',
		reflections: 'Reflections'
	};

	function pickTab(tab: DrawerTab) {
		activeTab = tab;
	}

	function handleClose() {
		onClose();
	}

	function handleVerify() {
		if (!unit || actionLoading) return;
		onVerify(unit.id);
	}

	function handleReject() {
		if (!unit || actionLoading) return;
		onReject(unit.id);
	}

	function handleRequestDelete() {
		if (!unit || actionLoading || deleting) return;
		onRequestDelete(unit.id);
	}

	function handleCancelDelete() {
		if (!unit || deleting) return;
		onCancelDelete(unit.id);
	}

	function handleConfirmDelete() {
		if (!unit || deleting) return;
		onConfirmDelete(unit.id);
	}
</script>

<aside
	class="drawer"
	class:open
	aria-hidden={!open}
	aria-label="Unit details"
>
	{#if unit}
		<div class="drawer-header">
			<div class="header-main">
				<div class="header-meta">
					<span
						class="unit-type-badge"
						style="background:{typeStyle.background};color:{typeStyle.color}"
					>
						{typeKey || 'UNIT'}
					</span>
					{#if unit.scout_name}
						<span class="scout-name">{unit.scout_name}</span>
					{/if}
					{#if verified}
						<span class="review-pill verified">✓ Verified</span>
					{:else}
						<span class="review-pill">⚠ Needs review</span>
					{/if}
				</div>
				{#if titleText}
					<h3 class="drawer-title">{titleText}</h3>
				{/if}
				{#if occurredLabel || extractedLabel}
					<div class="header-dates">
						{#if occurredLabel}
							<span>{occurredLabel}</span>
						{/if}
						{#if occurredLabel && extractedLabel}
							<span class="sep">·</span>
						{/if}
						{#if extractedLabel}
							<span>{extractedLabel}</span>
						{/if}
					</div>
				{/if}
				{#if sourceUrl}
					<a
						class="open-original"
						href={sourceUrl}
						target="_blank"
						rel="noopener noreferrer"
					>
						<ExternalLink size={12} />
						Open original{sourceDomain ? ` (${sourceDomain})` : ''}
					</a>
				{/if}
			</div>
			<button
				type="button"
				class="close-btn"
				on:click={handleClose}
				aria-label="Close drawer"
			>
				<X size={18} />
			</button>
		</div>

		<div class="drawer-tabs" role="tablist">
			{#each DRAWER_TABS as tab (tab)}
				<button
					type="button"
					role="tab"
					aria-selected={activeTab === tab}
					class="tab-btn"
					class:active={activeTab === tab}
					on:click={() => pickTab(tab)}
				>
					{TAB_LABELS[tab]}{tab === 'entities' ? ` · ${entityCount}` : ''}{tab === 'reflections' ? ` · ${reflectionCount}` : ''}
				</button>
			{/each}
		</div>

		<div class="drawer-body">
			{#if loading}
				<div class="body-loading">
					<Spinner size="md" />
				</div>
			{:else if activeTab === 'content'}
				{#if statementHtml}
					<div class="prose">{@html statementHtml}</div>
				{/if}
				{#if contextHtml}
					<div class="prose context">{@html contextHtml}</div>
				{/if}
				{#if sourceUrl || sourceDomain}
					<div class="source-block">
						<p class="source-label">Source</p>
						<div class="source-body">
							{#if sourceUrl}
								<a
									class="source-link"
									href={sourceUrl}
									target="_blank"
									rel="noopener noreferrer"
								>
									{sourceDomain || sourceUrl}
								</a>
							{:else}
								<p class="source-link">{sourceDomain}</p>
							{/if}
							{#if occurredLabel || extractedLabel}
								<p class="source-sub">
									{#if occurredLabel}Published {occurredLabel}{/if}{#if occurredLabel && extractedLabel} · {/if}{#if extractedLabel}extracted {extractedLabel}{/if}
								</p>
							{/if}
						</div>
					</div>
				{/if}
			{:else if activeTab === 'entities'}
				{#if entityCount === 0}
					<p class="empty-tab">No entities linked to this unit.</p>
				{:else}
					<div class="entity-grid">
						{#each unit.entities as entity (entity.mention_text + (entity.entity_id ?? ''))}
							<span class="entity-chip">{entity.mention_text}</span>
						{/each}
					</div>
				{/if}
			{:else if activeTab === 'reflections'}
				<p class="empty-tab">No reflections available yet.</p>
			{/if}
		</div>

		<div class="drawer-footer">
			{#if confirmingDelete}
				<button
					type="button"
					class="footer-btn cancel-delete-btn"
					on:click={handleCancelDelete}
					disabled={deleting}
				>
					Cancel
				</button>
				<button
					type="button"
					class="footer-btn delete-btn"
					on:click={handleConfirmDelete}
					disabled={deleting}
				>
					{#if deleting}
						<Spinner size="sm" />
					{:else}
						<Trash2 size={14} />
						<span>Delete permanently</span>
					{/if}
				</button>
			{:else}
				{#if !verified}
					<button
						type="button"
						class="footer-btn verify-btn"
						on:click={handleVerify}
						disabled={actionLoading !== null}
					>
						{#if actionLoading === 'verify'}
							<Spinner size="sm" variant="white" />
						{:else}
							<span>✓ Mark verified</span>
						{/if}
					</button>
				{/if}
				<button
					type="button"
					class="footer-btn delete-btn"
					on:click={handleRequestDelete}
					disabled={actionLoading !== null}
				>
					<Trash2 size={14} />
					<span>Delete</span>
				</button>
			{/if}
		</div>
	{/if}
</aside>

<style>
	.drawer {
		position: fixed;
		top: 0;
		right: 0;
		bottom: 0;
		width: 480px;
		max-width: 100vw;
		background: var(--color-surface-alt);
		border-left: 1px solid var(--color-border);
		box-shadow: var(--shadow-lg);
		display: flex;
		flex-direction: column;
		transform: translateX(100%);
		transition: transform 300ms cubic-bezier(0.4, 0, 0.2, 1);
		z-index: 40;
		font-family: var(--font-body);
	}

	.drawer.open {
		transform: translateX(0);
	}

	.drawer-header {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		padding: 1.25rem 1.25rem 1rem;
		border-bottom: 1px solid var(--color-border);
	}

	.header-main {
		flex: 1;
		min-width: 0;
	}

	.header-meta {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
		margin-bottom: 0.5rem;
	}

	.unit-type-badge {
		font-family: var(--font-mono);
		font-size: 0.625rem;
		font-weight: 500;
		letter-spacing: 0.1em;
		padding: 0.125rem 0.4375rem;
		text-transform: uppercase;
		border: 1px solid currentColor;
		border-radius: var(--radius-sm);
	}

	.scout-name {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--color-ink-muted);
	}

	.review-pill {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-family: var(--font-mono);
		font-size: 0.625rem;
		font-weight: 500;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		padding: 0.1875rem 0.5rem;
		border-radius: var(--radius-pill);
		background: var(--color-secondary-soft);
		color: var(--color-secondary);
		border: 1px solid var(--color-secondary);
	}

	.review-pill.verified {
		background: color-mix(in oklab, var(--color-success) 12%, transparent);
		color: var(--color-success);
		border-color: var(--color-success);
	}

	.drawer-title {
		font-family: var(--font-display);
		font-size: 1.25rem;
		font-weight: 600;
		color: var(--color-ink);
		line-height: 1.25;
		letter-spacing: -0.01em;
		margin: 0 0 0.5rem 0;
	}

	.header-dates {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		letter-spacing: 0.04em;
		color: var(--color-ink-muted);
		margin-bottom: 0.375rem;
	}

	.header-dates .sep {
		color: var(--color-border-strong);
	}

	.open-original {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--color-primary);
		text-decoration: none;
		border-bottom: 1px solid var(--color-primary-soft);
		transition: border-color 150ms ease;
	}

	.open-original:hover {
		border-bottom-color: var(--color-primary);
	}

	.close-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		background: transparent;
		border: 1px solid transparent;
		color: var(--color-ink-subtle);
		cursor: pointer;
		flex-shrink: 0;
		border-radius: var(--radius-sm);
		transition: background 150ms ease, color 150ms ease, border-color 150ms ease;
	}

	.close-btn:hover {
		background: var(--color-surface);
		color: var(--color-ink);
		border-color: var(--color-border);
	}

	.drawer-tabs {
		display: flex;
		gap: 0.25rem;
		padding: 0.5rem 1.25rem;
		border-bottom: 1px solid var(--color-border);
	}

	.tab-btn {
		padding: 0.5rem 0.75rem;
		background: transparent;
		border: none;
		border-radius: var(--radius-sm);
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--color-ink-muted);
		cursor: pointer;
		transition: color 150ms ease, background 150ms ease, transform 150ms ease;
	}

	.tab-btn:hover {
		color: var(--color-ink);
		background: var(--color-surface-hover);
	}

	.tab-btn.active {
		color: var(--color-foreground);
		background: color-mix(in oklab, var(--color-moonlight) 13%, var(--color-card));
	}

	.drawer-body {
		flex: 1;
		overflow-y: auto;
		padding: 1.25rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.body-loading {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 3rem 0;
	}

	.prose {
		font-family: var(--font-body);
		font-size: 0.9375rem;
		line-height: 1.6;
		color: var(--color-ink);
	}

	.prose.context {
		color: var(--color-ink-muted);
		font-weight: 500;
	}

	.prose :global(p) {
		margin: 0 0 0.75rem 0;
	}

	.prose :global(p:last-child) {
		margin-bottom: 0;
	}

	.prose :global(strong) {
		color: var(--color-ink);
		font-weight: 600;
	}

	.prose :global(a) {
		color: var(--color-primary);
	}

	.source-block {
		margin-top: 0.75rem;
		padding-top: 1rem;
		border-top: 1px solid var(--color-border);
	}

	.source-label {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.1em;
		color: var(--color-secondary);
		text-transform: uppercase;
		margin: 0 0 0.5rem 0;
	}

	.source-body {
		font-size: 0.8125rem;
		color: var(--color-ink);
	}

	.source-link {
		color: var(--color-primary);
		text-decoration: none;
		margin: 0;
		word-break: break-all;
	}

	.source-link:hover {
		text-decoration: underline;
	}

	.source-sub {
		color: var(--color-ink-subtle);
		margin: 0.25rem 0 0 0;
	}

	.empty-tab {
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--color-ink-muted);
		margin: 0;
	}

	.entity-grid {
		display: flex;
		gap: 0.375rem;
		flex-wrap: wrap;
	}

	.entity-chip {
		font-family: var(--font-mono);
		font-size: 0.75rem;
		font-weight: 400;
		letter-spacing: 0.04em;
		padding: 0.25rem 0.625rem;
		background: var(--color-surface);
		color: var(--color-ink);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-pill);
	}

	.drawer-footer {
		display: flex;
		gap: 0.5rem;
		padding: 0.75rem 1.25rem;
		border-top: 1px solid var(--color-border);
		background: var(--color-bg);
	}

	.footer-btn {
		flex: 1;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.375rem;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		padding: 0.625rem 0.75rem;
		cursor: pointer;
		transition: background 150ms ease, border-color 150ms ease;
		min-height: 2.25rem;
		border-radius: var(--radius-sm);
	}

	.footer-btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.verify-btn {
		background: var(--color-success);
		color: var(--color-bg);
		border: 1px solid var(--color-success);
	}

	.verify-btn:hover:not(:disabled) {
		background: var(--color-success);
		border-color: var(--color-success);
	}

	.delete-btn {
		background: var(--color-surface-alt);
		color: var(--color-error);
		border: 1px solid color-mix(in oklab, var(--color-error) 32%, var(--color-border));
	}

	.delete-btn:hover:not(:disabled) {
		background: color-mix(in oklab, var(--color-error) 10%, transparent);
	}

	.cancel-delete-btn {
		background: var(--color-surface-alt);
		color: var(--color-ink-muted);
		border: 1px solid var(--color-border);
	}

	.cancel-delete-btn:hover:not(:disabled) {
		border-color: var(--color-border-strong);
		color: var(--color-ink);
	}
</style>

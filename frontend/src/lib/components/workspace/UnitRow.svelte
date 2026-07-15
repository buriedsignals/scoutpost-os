<script lang="ts">
	import { ExternalLink, Check, Trash2, X } from 'lucide-svelte';
	import Spinner from '$lib/components/ui/Spinner.svelte';
	import type { Unit } from '$lib/types/workspace';
	import { isDemoUnit } from '$lib/demo/seed';
	import DemoBadge from '$lib/components/ui/DemoBadge.svelte';
	import * as HoverCard from '$lib/components/ui/hover-card/index.js';
	import { cleanUnitStatement, getUnitTypeStyle } from '$lib/utils/units';
	import { searchMatchClass, searchMatchLabel } from '$lib/utils/unit-search';

	export let unit: Unit;
	export let selected = false;
	export let confirmingDelete = false;
	export let deleting = false;
	export let verifying = false;
	export let showSearchMatch = false;
	export let onOpen: (unit: Unit) => void = () => {};
	export let onVerify: (id: string) => void = () => {};
	export let onReject: (id: string) => void = () => {};
	export let onRequestDelete: (id: string) => void = () => {};
	export let onCancelDelete: (id: string) => void = () => {};
	export let onConfirmDelete: (id: string) => void = () => {};

	$: isDemo = isDemoUnit(unit);

	// --- Derived state ---

	$: verified = unit.verification?.verified === true;

	$: typeKey = (unit.unit_type ?? '').toUpperCase();

	$: typeStyle = getUnitTypeStyle(typeKey);

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

	$: occurredLabel = formatOccurred(unit.occurred_at);
	$: extractedLabel = formatExtractedRel(unit.extracted_at);

	$: scoutName = unit.scout_name ?? '';
	$: sourceDomain = unit.source?.domain ?? '';
	$: sourceUrl = unit.source?.url ?? '';

	$: topEntities = (unit.entities ?? []).slice(0, 5);
	$: searchMatch = showSearchMatch ? unit.search_match ?? null : null;
	$: searchPillLabel = searchMatch ? searchMatchLabel(searchMatch) : null;
	$: searchPillClass = searchMatch ? searchMatchClass(searchMatch.category) : null;

	function handleRowClick() {
		onOpen(unit);
	}

	function handleKey(event: KeyboardEvent) {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			onOpen(unit);
		}
	}

	function handleVerify(event: MouseEvent) {
		if (verifying || deleting) return;
		event.stopPropagation();
		onVerify(unit.id);
	}

	function handleReject(event: MouseEvent) {
		if (verifying || deleting) return;
		event.stopPropagation();
		onReject(unit.id);
	}

	function handleRequestDelete(event: MouseEvent) {
		if (verifying || deleting) return;
		event.stopPropagation();
		onRequestDelete(unit.id);
	}

	function handleCancelDelete(event: MouseEvent) {
		event.stopPropagation();
		onCancelDelete(unit.id);
	}

	function handleConfirmDelete(event: MouseEvent) {
		event.stopPropagation();
		onConfirmDelete(unit.id);
	}
</script>

<div
	class="unit-row"
	class:selected
	class:verified
	class:confirmingDelete
	on:click={handleRowClick}
	on:keydown={handleKey}
	role="button"
	tabindex="0"
>
	<div class="unit-meta">
		<span class="unit-type-badge" style="background:{typeStyle.background};color:{typeStyle.color}">
			{typeKey || 'UNIT'}
		</span>
		{#if scoutName}
			<span class="unit-scout-name">{scoutName}</span>
		{/if}
		{#if sourceDomain || occurredLabel || extractedLabel}
			<span class="unit-dates">
				{#if sourceDomain && sourceUrl}
					<HoverCard.Root openDelay={180} closeDelay={120}>
						<HoverCard.Trigger
							href={sourceUrl}
							target="_blank"
							rel="noopener noreferrer"
							class="unit-source-link"
							onclick={(event) => event.stopPropagation()}
						>· {sourceDomain}</HoverCard.Trigger>
						<HoverCard.Content align="start" sideOffset={8} class="w-72 rounded-xl bg-popover/95 p-3.5 text-popover-foreground shadow-[0_18px_48px_oklch(0.06_0.015_210/0.5)] backdrop-blur-xl">
							<span class="source-preview-label">Source capture</span>
							<strong>{unit.source?.title || sourceDomain}</strong>
							<span>{sourceDomain}{#if extractedLabel} · captured {extractedLabel}{/if}</span>
							<small>Source and capture metadata remain attached through editorial review.</small>
						</HoverCard.Content>
					</HoverCard.Root>
				{:else if sourceDomain}
					<span>· {sourceDomain}</span>
				{/if}
				{#if occurredLabel}
					<span>· {occurredLabel}</span>
				{/if}
				{#if extractedLabel}
					<span>· {extractedLabel}</span>
				{/if}
			</span>
		{/if}
		{#if verified}
			<span class="review-pill verified">✓ Verified</span>
		{:else}
			<span class="review-pill">⚠ Needs review</span>
		{/if}
		{#if searchMatch && searchPillLabel && searchPillClass}
			<span class="search-pill {searchPillClass}" title={searchMatch.reason}>
				{searchPillLabel}
			</span>
		{/if}
		{#if isDemo}
			<DemoBadge />
		{/if}
	</div>

	{#if unit.statement}
		<p class="unit-statement">{cleanUnitStatement(unit.statement)}</p>
	{/if}

	{#if searchMatch}
		<p class="search-reason">{searchMatch.reason}</p>
	{/if}

	{#if topEntities.length > 0}
		<div class="unit-entities">
			{#each topEntities as entity (entity.mention_text + (entity.entity_id ?? ''))}
				<span class="entity-chip">{entity.mention_text}</span>
			{/each}
		</div>
	{/if}

	<div class="unit-actions" on:click|stopPropagation on:keydown|stopPropagation role="toolbar" tabindex="-1">
		{#if confirmingDelete}
			<div class="unit-delete-confirm" role="toolbar" tabindex="-1">
				{#if deleting}
					<Spinner size="sm" />
				{:else}
					<button
						class="unit-confirm-btn cancel"
						on:click={handleCancelDelete}
						aria-label="Cancel"
						type="button"
					>
						<X size={12} />
					</button>
					<span class="unit-delete-label">Delete?</span>
					<button
						class="unit-confirm-btn confirm"
						on:click={handleConfirmDelete}
						aria-label="Confirm delete"
						type="button"
					>
						<Check size={12} />
					</button>
				{/if}
			</div>
		{:else}
			{#if sourceUrl}
				<a
					class="unit-action-btn"
					href={sourceUrl}
					target="_blank"
					rel="noopener noreferrer"
					aria-label="Open source"
					title="Open source"
				>
					<ExternalLink size={14} />
				</a>
			{/if}
			{#if !verified}
				<button
					class="unit-action-btn verify"
					on:click={handleVerify}
					aria-label="Mark verified"
					title="Mark verified"
					type="button"
					disabled={verifying || deleting}
				>
					{#if verifying}
						<Spinner size="sm" />
					{:else}
						<Check size={14} strokeWidth={2.5} />
					{/if}
				</button>
			{/if}
			<button
				class="unit-action-btn delete"
				on:click={handleRequestDelete}
				aria-label="Delete unit"
				title="Delete unit"
				type="button"
				disabled={verifying || deleting}
			>
				<Trash2 size={14} strokeWidth={2.25} />
			</button>
		{/if}
	</div>
</div>

<style>
	.unit-row {
		display: flex;
		flex-direction: column;
		gap: 0.4375rem;
		padding: 1rem 1.5rem;
		border-bottom: 1px solid var(--color-border);
		cursor: pointer;
		transition: background 150ms ease, box-shadow 150ms ease;
		position: relative;
		background: var(--color-surface-alt);
		font-family: var(--font-body);
	}

	.unit-row:hover {
		background: color-mix(in oklch, var(--color-surface-alt) 92%, var(--color-ink));
		box-shadow: inset 0 1px oklch(0.87 0.025 205 / 4%), inset 0 -1px oklch(0.87 0.025 205 / 4%);
	}

	.unit-row.selected {
		background: oklch(0.48 0.035 205 / 24%);
	}

	.unit-row.verified {
		opacity: 0.55;
	}

	.unit-row:focus-visible {
		outline: 2px solid var(--color-primary);
		outline-offset: -2px;
	}

	.unit-meta {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
		font-size: 0.75rem;
		color: var(--color-ink-muted);
	}

	.unit-type-badge {
		font-family: var(--font-mono);
		font-size: 0.625rem;
		font-weight: 500;
		letter-spacing: 0.1em;
		padding: 0.125rem 0.4375rem;
		text-transform: uppercase;
		border: 1px solid currentColor;
	}

	.unit-scout-name {
		font-family: var(--font-mono);
		font-weight: 500;
		font-size: 0.6875rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--color-ink);
	}

	.unit-dates {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		letter-spacing: 0.04em;
		color: var(--color-ink-subtle);
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		flex-wrap: wrap;
	}

	.unit-source-link {
		border-radius: var(--radius-sm);
		color: oklch(0.76 0.065 200);
		text-decoration: underline;
		text-decoration-color: oklch(0.56 0.055 200 / 42%);
		text-underline-offset: 3px;
		transition: color 150ms ease, background 150ms ease;
	}

	.unit-source-link:hover {
		background: var(--color-secondary-soft);
		color: var(--color-ink);
	}

	:global([data-slot='hover-card-content']) strong,
	:global([data-slot='hover-card-content']) small,
	:global([data-slot='hover-card-content']) span {
		display: block;
	}

	:global([data-slot='hover-card-content']) strong {
		margin-top: 0.45rem;
		font-size: 0.78rem;
		font-weight: 650;
		line-height: 1.35;
	}

	:global([data-slot='hover-card-content']) small,
	:global([data-slot='hover-card-content']) span {
		margin-top: 0.3rem;
		color: var(--muted-foreground);
		font-size: 0.68rem;
		line-height: 1.5;
	}

	:global([data-slot='hover-card-content'] .source-preview-label) {
		margin-top: 0;
		color: oklch(0.76 0.065 200);
		font-family: var(--font-mono);
		font-size: 0.56rem;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.unit-statement {
		font-family: var(--font-body);
		font-size: 0.9375rem;
		font-weight: 500;
		line-height: 1.55;
		color: var(--color-ink);
		margin: 0;
	}

	.unit-entities {
		display: flex;
		gap: 0.3125rem;
		flex-wrap: wrap;
	}

	.entity-chip {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 400;
		letter-spacing: 0.04em;
		padding: 0.125rem 0.5rem;
		background: var(--color-surface);
		color: var(--color-ink-muted);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-pill);
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
		background: oklch(0.76 0.12 82 / 14%);
		color: var(--color-warning);
		border: 1px solid oklch(0.76 0.12 82 / 36%);
		margin-left: auto;
		white-space: nowrap;
	}

	.review-pill.verified {
		background: oklch(0.72 0.09 155 / 13%);
		color: var(--color-success);
		border-color: var(--color-success);
	}

	.search-pill {
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
		border: 1px solid transparent;
	}

	.search-pill.direct {
		background: oklch(0.87 0.025 205 / 11%);
		color: oklch(0.87 0.025 205);
		border-color: oklch(0.87 0.025 205 / 26%);
	}

	.search-pill.related {
		background: var(--color-secondary-soft);
		color: oklch(0.72 0.06 200);
		border-color: oklch(0.56 0.055 200 / 38%);
	}

	.search-pill.loose {
		background: oklch(0.69 0.11 28 / 10%);
		color: var(--color-error);
		border-color: oklch(0.69 0.11 28 / 32%);
	}

	.search-reason {
		margin: -0.1rem 0 0;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		letter-spacing: 0.04em;
		color: var(--color-ink-subtle);
	}

	.unit-actions {
		position: absolute;
		top: 0.75rem;
		right: 1rem;
		display: none;
		background: var(--color-surface-alt);
		border: 1px solid var(--color-border);
		padding: 0.25rem;
		box-shadow: var(--shadow-md);
		gap: 0.125rem;
		border-radius: var(--radius-md);
	}

	.unit-row:hover .unit-actions,
	.unit-row.confirmingDelete .unit-actions {
		display: flex;
	}

	.unit-action-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		border: 1px solid transparent;
		background: transparent;
		color: var(--color-ink-muted);
		cursor: pointer;
		transition: background 150ms ease, color 150ms ease, border-color 150ms ease;
		text-decoration: none;
		border-radius: var(--radius-sm);
	}

	.unit-action-btn:disabled {
		cursor: default;
		opacity: 0.7;
	}

	.unit-action-btn:hover {
		background: var(--color-surface);
		color: var(--color-ink);
	}

	.unit-action-btn.verify:hover {
		background: oklch(0.72 0.09 155 / 13%);
		color: var(--color-success);
		border-color: var(--color-success);
	}

	.unit-action-btn.delete:hover {
		background: oklch(0.69 0.11 28 / 10%);
		color: var(--color-error);
		border-color: oklch(0.69 0.11 28 / 32%);
	}

	.unit-delete-confirm {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
	}

	.unit-delete-label {
		font-family: var(--font-mono);
		font-size: 0.625rem;
		font-weight: 500;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--color-ink-muted);
		padding: 0 0.25rem;
	}

	.unit-confirm-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		border: 1px solid var(--color-border);
		background: var(--color-surface-alt);
		color: var(--color-ink-muted);
		cursor: pointer;
		border-radius: var(--radius-sm);
	}

	.unit-confirm-btn.cancel:hover {
		border-color: var(--color-border-strong);
		color: var(--color-ink);
	}

	.unit-confirm-btn.confirm:hover {
		background: oklch(0.69 0.11 28 / 10%);
		color: var(--color-error);
		border-color: oklch(0.69 0.11 28 / 32%);
	}
</style>

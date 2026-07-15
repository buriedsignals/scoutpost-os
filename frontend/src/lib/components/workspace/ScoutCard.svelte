<script lang="ts">
	import { Globe, MapPin, Tag, Calendar, Play, Trash2, X, Check } from 'lucide-svelte';
	import Spinner from '$lib/components/ui/Spinner.svelte';
	import DemoBadge from '$lib/components/ui/DemoBadge.svelte';
	import {
		truncateUrl,
		getScoutTypeDisplay,
		normalizeScoutType,
		getScoutStatus,
		getScoutStatusLabel
	} from '$lib/utils/scouts';
	import { parseTopicTags } from '$lib/utils/topics';
	import { tooltip } from '$lib/utils/tooltip';
	import type { Scout } from '$lib/types/workspace';

	export let scout: Scout;
	export let dimmed = false;
	export let running = false;
	export let confirmingDelete = false;
	export let deleting = false;
	export let demo = false;
	export let onOpen: (scout: Scout) => void = () => {};
	export let onRun: (id: string) => void = () => {};
	export let onRequestDelete: (id: string) => void = () => {};
	export let onConfirmDelete: (id: string) => void = () => {};
	export let onCancelDelete: (id: string) => void = () => {};

	$: cfg = getScoutTypeDisplay(scout.type);
	$: normalizedType = normalizeScoutType(scout.type);

	function locationDisplay(loc: unknown): string | null {
		if (!loc || typeof loc !== 'object') return null;
		const rec = loc as Record<string, unknown>;
		const dn = rec.displayName ?? rec.display_name;
		return typeof dn === 'string' ? dn : null;
	}

	$: locDisplay = locationDisplay(scout.location);
	$: topicTags = parseTopicTags(scout.topic).slice(0, 3);

	function timeSince(iso: string | null | undefined): string | null {
		if (!iso) return null;
		const then = new Date(iso).getTime();
		if (!Number.isFinite(then)) return null;
		const seconds = Math.floor((Date.now() - then) / 1000);
		if (seconds < 60) return `${seconds}s ago`;
		if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
		if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
		const days = Math.floor(seconds / 86400);
		return days === 1 ? '1d ago' : `${days}d ago`;
	}

	$: lastRunText = (() => {
		if (!scout.last_run?.started_at) return 'Awaiting first run';
		const rel = timeSince(scout.last_run.started_at);
		return rel ? `Last run ${rel}` : 'Awaiting first run';
	})();

	$: status = getScoutStatus({ type: normalizedType, last_run: scout.last_run });
	$: statusLabel = getScoutStatusLabel(status);

	$: canRun = scout.is_active !== false;

	$: scheduleLabel = (() => {
		if (!scout.regularity) return null;
		const r = scout.regularity.toLowerCase();
		if (r === 'daily') return 'Daily';
		if (r === 'weekly') return 'Weekly';
		if (r === 'monthly') return 'Monthly';
		return r.charAt(0).toUpperCase() + r.slice(1);
	})();

	function handleCardClick() {
		onOpen(scout);
	}

	function handleKey(e: KeyboardEvent) {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			handleCardClick();
		}
	}
</script>

<div
	class="scout-shell scout-card {cfg.className}"
	class:dimmed
	class:deleting
	class:demo
	on:click={handleCardClick}
	on:keydown={handleKey}
	role="button"
	tabindex="0"
>
	<div class="scout-shell-eyebrow-row">
		<div class="scout-card-eyebrow-group">
			<span class="scout-shell-eyebrow {cfg.className}">
				<span class="scout-shell-eyebrow-icon">
					<svelte:component this={cfg.icon} size={12} />
				</span>
				<span class="scout-shell-eyebrow-label">{cfg.label}</span>
			</span>
			{#if demo}
				<DemoBadge variant="pill" />
			{/if}
		</div>
		{#if !demo}
		<div class="scout-shell-actions">
			{#if running}
				<div class="scout-shell-spinner" on:click|stopPropagation on:keydown|stopPropagation role="presentation">
					<Spinner size="sm" />
				</div>
			{:else}
				<button
					on:click|stopPropagation={() => onRun(scout.id)}
					class="scout-shell-icon-btn run-btn"
					disabled={!canRun}
					aria-label="Run now"
					use:tooltip={canRun ? 'Run now' : 'Resume scout to run'}
				>
					<Play size={14} />
				</button>
			{/if}
			{#if confirmingDelete}
				<div class="scout-shell-confirm" on:click|stopPropagation on:keydown|stopPropagation role="toolbar" tabindex="-1">
					{#if deleting}
						<Spinner size="sm" />
					{:else}
						<button
							on:click|stopPropagation={() => onCancelDelete(scout.id)}
							class="scout-shell-confirm-btn cancel"
							aria-label="Cancel"
						>
							<X size={12} />
						</button>
						<span class="scout-shell-confirm-label">Delete?</span>
						<button
							on:click|stopPropagation={() => onConfirmDelete(scout.id)}
							class="scout-shell-confirm-btn confirm"
							aria-label="Yes"
						>
							<Check size={12} />
						</button>
					{/if}
				</div>
			{:else}
				<button
					on:click|stopPropagation={() => onRequestDelete(scout.id)}
					class="scout-shell-icon-btn trash-btn"
					aria-label="Delete scout"
				>
					<Trash2 size={14} />
				</button>
			{/if}
		</div>
		{/if}
	</div>

	<h3 class="scout-shell-name scout-card-name">{scout.name}</h3>

	<div class="scout-card-body">
		{#if locDisplay}
			<div class="scout-meta-item">
				<MapPin size={14} />
				<span class="scout-meta-text">{locDisplay}</span>
			</div>
		{/if}
		{#if topicTags.length}
			<div class="scout-meta-item scout-topic-item">
				<Tag size={14} />
				<span class="scout-topic-tags" title={scout.topic || ''}>
					{#each topicTags as tag}
						<span class="scout-topic-chip">{tag}</span>
					{/each}
				</span>
			</div>
		{/if}
		{#if normalizedType === 'web' && scout.url}
			<div class="scout-meta-item scout-url">
				<Globe size={14} />
				<span class="scout-url-text" title={scout.url}>{truncateUrl(scout.url)}</span>
			</div>
		{/if}
		<div class="scout-meta-item">
			<Calendar size={14} />
			<span>{lastRunText}</span>
		</div>
	</div>

	<div class="scout-card-footer">
		<span
			class="scout-shell-status"
			class:status-success={status.variant === 'success'}
			class:status-error={status.variant === 'error'}
			class:status-neutral={status.variant === 'neutral'}
			class:status-warning={status.variant === 'warning'}
			class:status-waiting={status.variant === 'waiting'}
		>
			<span class="scout-shell-status-dot"></span>
			{statusLabel}
		</span>
		{#if scheduleLabel}
			<span class="scout-shell-schedule">{scheduleLabel}</span>
		{/if}
	</div>
</div>

<style>
	/* Size/padding overrides for the workspace-grid variant — shell
	   primitives live in app.css under "Scout display primitives". */
	.scout-card {
		padding: 0.875rem 1.125rem;
		cursor: pointer;
		min-height: 152px;
	}

	.scout-card-name {
		font-size: 1.25rem;
	}

	.scout-card-body {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		margin-bottom: 0.75rem;
	}

	.scout-card-eyebrow-group {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}

	.scout-meta-item {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--color-ink-muted);
	}

	.scout-meta-item :global(svg) {
		flex: 0 0 auto;
		margin-top: 0.125rem;
	}

	.scout-topic-item {
		align-items: flex-start;
	}

	.scout-topic-tags {
		display: flex;
		flex-wrap: wrap;
		gap: 0.375rem;
		min-width: 0;
		max-height: 3.1rem;
		overflow: hidden;
	}

	.scout-topic-chip {
		display: inline-flex;
		align-items: center;
		max-width: 100%;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--color-ink-muted);
		font-size: 0.8125rem;
		font-family: var(--font-body);
		letter-spacing: 0;
		line-height: 1.25;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.scout-topic-chip + .scout-topic-chip::before {
		content: "·";
		margin-right: 0.375rem;
		color: var(--color-border-strong);
	}

	.scout-meta-text {
		min-width: 0;
		overflow: hidden;
	}

	.scout-url {
		color: var(--color-primary);
		align-items: center;
	}

	.scout-url-text {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 200px;
	}

	.scout-card-footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--color-border);
		margin-top: auto;
	}
</style>

<script lang="ts">
	import { MapPin, Tag, Calendar, Play, Trash2, ArrowLeft, X, Check, Globe, AtSign } from 'lucide-svelte';
	import Spinner from '$lib/components/ui/Spinner.svelte';
	import DemoBadge from '$lib/components/ui/DemoBadge.svelte';
	import { getScoutTypeDisplay, normalizeScoutType, truncateUrl } from '$lib/utils/scouts';
	import { parseTopicTags } from '$lib/utils/topics';
	import type { Scout } from '$lib/types/workspace';

	export let scout: Scout;
	export let running = false;
	export let confirmingDelete = false;
	export let deleting = false;
	export let totalScouts = 0;
	export let demo = false;
	export let onBack: () => void = () => {};
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
	$: descriptionText = scout.description || scout.criteria || null;
	$: trackedUrls = Array.isArray(scout.tracked_urls)
		? scout.tracked_urls.filter((url): url is string => typeof url === 'string' && url.length > 0)
		: [];
	$: targetDisplay = (() => {
		if (normalizedType === 'web' && scout.url) {
			return {
				kind: 'url' as const,
				label: 'Target URL',
				value: truncateUrl(scout.url, 84),
				title: scout.url,
				extra: null
			};
		}

		if (normalizedType === 'civic') {
			const primaryUrl = trackedUrls[0] ?? scout.url ?? null;
			if (primaryUrl) {
				return {
					kind: 'url' as const,
					label: trackedUrls.length > 1 ? 'Target URLs' : 'Target URL',
					value: truncateUrl(primaryUrl, 84),
					title: trackedUrls.length > 1 ? trackedUrls.join('\n') : primaryUrl,
					extra: trackedUrls.length > 1 ? `${trackedUrls.length} URLs total` : scout.root_domain ?? null
				};
			}
			if (scout.root_domain) {
				return {
					kind: 'url' as const,
					label: 'Target domain',
					value: scout.root_domain,
					title: scout.root_domain,
					extra: null
				};
			}
		}

		if (normalizedType === 'social') {
			const handle = scout.profile_handle
				? scout.profile_handle.replace(/^@/, '')
				: null;
			if (handle) {
				return {
					kind: 'profile' as const,
					label: 'Target profile',
					value: `@${handle}`,
					title: scout.url ?? `@${handle}`,
					extra: scout.platform ?? null
				};
			}
			if (scout.url) {
				return {
					kind: 'profile' as const,
					label: 'Target profile',
					value: truncateUrl(scout.url, 84),
					title: scout.url,
					extra: scout.platform ?? null
				};
			}
		}

		return null;
	})();

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

	$: lastRunLabel = scout.last_run?.started_at ? `Last run ${timeSince(scout.last_run.started_at)}` : 'Awaiting first run';
	$: articleCount = scout.last_run?.articles_count ?? null;

	$: scheduleLabel = (() => {
		if (!scout.regularity) return null;
		const r = scout.regularity.toLowerCase();
		if (r === 'daily') return 'Daily';
		if (r === 'weekly') return 'Weekly';
		if (r === 'monthly') return 'Monthly';
		return r.charAt(0).toUpperCase() + r.slice(1);
	})();

	$: status = (() => {
		if (!scout.last_run?.started_at) return { variant: 'waiting' as const, label: 'Awaiting first run' };
		if (scout.last_run.status === 'running' || scout.last_run.status === 'queued')
			return { variant: 'waiting' as const, label: 'Running' };
		if (scout.last_run.status === 'failed' || scout.last_run.status === 'error')
			return { variant: 'error' as const, label: 'Run failed' };
		if ((scout.last_run.articles_count ?? 0) > 0)
			return { variant: 'success' as const, label: 'New findings' };
		return { variant: 'neutral' as const, label: 'No new findings' };
	})();

	$: canRun = scout.is_active !== false;

	function handleBack() { onBack(); }
</script>

<div class="scout-focus-wrapper">
	<button class="back-btn" on:click={handleBack}>
		<ArrowLeft size={14} strokeWidth={2.25} />
		<span>All scouts</span>
		{#if totalScouts}
			<span class="back-btn-count">{totalScouts}</span>
		{/if}
	</button>

	<div class="scout-shell scout-focus {cfg.className}">
		<div class="scout-shell-eyebrow-row">
			<span class="scout-shell-eyebrow {cfg.className}">
				<span class="scout-shell-eyebrow-icon">
					<svelte:component this={cfg.icon} size={12} />
				</span>
				<span class="scout-shell-eyebrow-label">{cfg.label}</span>
			</span>
			{#if demo}
				<div class="scout-shell-actions">
					<DemoBadge label="EXAMPLE · READ-ONLY" />
				</div>
			{:else}
			<div class="scout-shell-actions">
				{#if running}
					<div class="scout-shell-spinner"><Spinner size="sm" /></div>
				{:else}
					<button
						class="scout-shell-icon-btn run-btn"
						on:click={() => onRun(scout.id)}
						disabled={!canRun}
						aria-label="Run now"
						title={canRun ? 'Run now' : 'Resume scout to run'}
					>
						<Play size={14} />
					</button>
				{/if}
				{#if confirmingDelete}
					<div class="scout-shell-confirm">
						{#if deleting}
							<Spinner size="sm" />
						{:else}
							<button class="scout-shell-confirm-btn cancel" on:click={() => onCancelDelete(scout.id)} aria-label="Cancel">
								<X size={12} />
							</button>
							<span class="scout-shell-confirm-label">Delete?</span>
							<button class="scout-shell-confirm-btn confirm" on:click={() => onConfirmDelete(scout.id)} aria-label="Yes">
								<Check size={12} />
							</button>
						{/if}
					</div>
				{:else}
					<button
						class="scout-shell-icon-btn trash-btn"
						on:click={() => onRequestDelete(scout.id)}
						aria-label="Delete"
					>
						<Trash2 size={14} />
					</button>
				{/if}
			</div>
			{/if}
		</div>

		<h2 class="scout-shell-name scout-focus-name">{scout.name}</h2>

		<div class="focus-meta-row">
			{#if locDisplay}
				<span class="focus-meta-item">
					<MapPin size={12} />
					{locDisplay}
				</span>
				<span class="focus-sep">·</span>
			{/if}
			{#if topicTags.length}
				<span class="focus-meta-item">
					<Tag size={12} />
					<span class="focus-topic-tags" title={scout.topic || ''}>
						{#each topicTags as tag}
							<span class="focus-topic-chip">{tag}</span>
						{/each}
					</span>
				</span>
				<span class="focus-sep">·</span>
			{/if}
			<span class="focus-meta-item">
				<Calendar size={12} />
				{lastRunLabel}
			</span>
			{#if scheduleLabel}
				<span class="focus-sep">·</span>
				<span class="scout-shell-schedule">{scheduleLabel}</span>
			{/if}
		</div>

		{#if targetDisplay}
			<div class="focus-target" title={targetDisplay.title}>
				<span class="focus-target-icon">
					{#if targetDisplay.kind === 'profile'}
						<AtSign size={13} />
					{:else}
						<Globe size={13} />
					{/if}
				</span>
				<span class="focus-target-label">{targetDisplay.label}</span>
				<span class="focus-target-value">{targetDisplay.value}</span>
				{#if targetDisplay.extra}
					<span class="focus-target-extra">{targetDisplay.extra}</span>
				{/if}
			</div>
		{/if}

		{#if descriptionText}
			<p class="focus-description">{descriptionText}</p>
		{/if}

		{#if scout.last_run?.started_at}
			<div class="summary-strip">
				<p class="summary-label">Last run summary</p>
				{#if scout.last_run.status === 'failed' || scout.last_run.status === 'error'}
					<p class="summary-body error">The last run encountered an error. Check logs or retry.</p>
				{:else if scout.last_run.status === 'running' || scout.last_run.status === 'queued'}
					<p class="summary-body neutral">Run in progress.</p>
				{:else if articleCount !== null && articleCount > 0}
					<p class="summary-body">Found <strong>{articleCount}</strong> new {articleCount === 1 ? 'finding' : 'findings'} in the most recent run.</p>
				{:else}
					<p class="summary-body neutral">No new findings in the most recent run.</p>
				{/if}
			</div>
		{/if}

		<div class="focus-footer">
			<span
				class="scout-shell-status"
				class:status-success={status.variant === 'success'}
				class:status-error={status.variant === 'error'}
				class:status-waiting={status.variant === 'waiting'}
				class:status-neutral={status.variant === 'neutral'}
			>
				<span class="scout-shell-status-dot"></span>
				{status.label}
			</span>
			{#if scout.consecutive_failures && scout.consecutive_failures > 0}
				<span class="failure-note">{scout.consecutive_failures} consecutive failure{scout.consecutive_failures === 1 ? '' : 's'}</span>
			{/if}
		</div>
	</div>
</div>

<style>
	/* Focus-specific overrides — shell primitives live in app.css under
	   "Scout display primitives"; this file only carries the larger
	   title size, the meta row, summary strip, and back-chip above. */
	.scout-focus-wrapper {
		padding: 0 2rem;
		margin-top: 1.25rem;
		margin-bottom: 1.5rem;
		font-family: var(--font-body);
	}

	.back-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.4375rem;
		height: 32px;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--color-ink-muted);
		background: var(--color-surface-alt);
		border: 1px solid var(--color-border);
		cursor: pointer;
		padding: 0 0.75rem;
		margin-bottom: 0.875rem;
		transition: border-color 150ms ease, color 150ms ease, background 150ms ease;
	}
	.back-btn:hover {
		color: var(--color-primary);
		border-color: var(--color-primary);
		background: var(--color-primary-soft);
	}
	.back-btn-count {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 1.25rem;
		padding: 0 0.375rem;
		height: 1.125rem;
		font-size: 0.6875rem;
		font-weight: 500;
		color: var(--color-ink-muted);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		margin-left: 0.125rem;
	}
	.back-btn:hover .back-btn-count {
		background: var(--color-bg);
		color: var(--color-primary);
	}

	.scout-focus {
		overflow: hidden;
		padding: 0.875rem 1.25rem 1rem;
	}

	.scout-focus-name {
		font-size: 1.5rem;
	}

	.focus-meta-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		letter-spacing: 0.04em;
		color: var(--color-ink-muted);
		flex-wrap: wrap;
	}

	.focus-meta-item {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
	}

	.focus-topic-tags {
		display: inline-flex;
		flex-wrap: wrap;
		gap: 0.375rem;
	}

	.focus-topic-chip {
		display: inline-flex;
		align-items: center;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--color-ink-muted);
		line-height: 1.25;
	}

	.focus-topic-chip + .focus-topic-chip::before {
		content: "·";
		margin-right: 0.375rem;
		color: var(--color-border-strong);
	}

	.focus-sep { color: var(--color-border-strong); }

	.focus-description {
		max-width: 76rem;
		margin: 0.75rem 0 0;
		color: var(--color-ink-muted);
		font-family: var(--font-body);
		font-size: 0.9375rem;
		font-weight: 300;
		line-height: 1.55;
	}

	.focus-target {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		max-width: 76rem;
		margin-top: 0.75rem;
		padding: 0.5rem 0;
		border-top: 1px solid var(--color-border);
		border-bottom: 1px solid var(--color-border);
		color: var(--color-ink-muted);
		font-family: var(--font-body);
		font-size: 0.875rem;
		min-width: 0;
	}

	.focus-target-icon {
		display: inline-flex;
		align-items: center;
		color: var(--color-ink-muted);
		flex: 0 0 auto;
	}

	.focus-target-label {
		flex: 0 0 auto;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--color-ink-subtle);
	}

	.focus-target-value {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--color-ink);
		font-weight: 400;
	}

	.focus-target-extra {
		flex: 0 0 auto;
		color: var(--color-ink-subtle);
		font-size: 0.8125rem;
	}

	.summary-strip {
		margin-top: 0.875rem;
		padding: 0.75rem 0.875rem;
		background: var(--color-bg);
		border: 1px solid var(--color-border);
	}

	.summary-label {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.1em;
		color: var(--color-secondary);
		text-transform: uppercase;
		margin: 0 0 0.375rem 0;
	}

	.summary-body {
		font-family: var(--font-body);
		font-size: 0.9375rem;
		color: var(--color-ink);
		line-height: 1.55;
		margin: 0;
	}
	.summary-body.error   { color: var(--color-error); }
	.summary-body.neutral { color: var(--color-ink-muted); font-weight: 300; }

	.focus-footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		margin-top: 0.75rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--color-border);
	}

	.failure-note {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		letter-spacing: 0.05em;
		color: var(--color-error);
		font-weight: 500;
	}
</style>

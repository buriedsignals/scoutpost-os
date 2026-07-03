<script lang="ts">
	import { onMount } from 'svelte';
	import { X, Globe, ScanSearch, Tag, MapPin, Bell, CheckCircle, Mail, Filter, Ban, Star, Users, Landmark } from 'lucide-svelte';
	import { fade } from 'svelte/transition';
	import type { GeocodedLocation, RegularityType, ScoutType, ScrapeChannel, ActiveJobsResponse } from '$lib/types';
	import { apiClient } from '$lib/api-client';
	import { authStore } from '$lib/stores/auth';
	import TimePicker from '$lib/components/ui/TimePicker.svelte';
	import LocationAutocomplete from '$lib/components/ui/LocationAutocomplete.svelte';
	import TopicChips from '$lib/components/ui/TopicChips.svelte';
	import { getScoutCost } from '$lib/utils/scouts';
	import { collectTopicCounts } from '$lib/utils/topics';
	import * as m from '$lib/paraglide/messages';

	export let open = false;
	export let scoutType: ScoutType = 'pulse';

	// Beat Scout context (pulse)
	export let location: GeocodedLocation | null = null;
	export let topic: string = '';
	export let criteria: string = '';

	// Page Scout context (web)
	export let url: string = '';
	export let webCriteria: string = '';
	export let provider: string | undefined = undefined;
	export let scoutName: string = '';
	export let contentHash: string | undefined = undefined;

	// Social Scout context (social)
	export let profile_handle: string = '';
	export let platform: string = 'instagram';
	export let monitor_mode: string = 'summarize';
	export let trackRemovals: boolean = false;
	export let baselinePosts: Record<string, unknown>[] = [];

	// Civic Scout context (civic)
	export let root_domain: string = '';
	export let tracked_urls: string[] = [];
	export let initialPromises: Array<{ promise_text: string; context: string; source_url: string; source_date: string; due_date?: string; date_confidence: string; criteria_match: boolean }> = [];
	export let onClose: () => void = () => {};
	export let onSuccess: (detail: { name: string; scoutType: ScoutType }) => void = () => {};

	// Flat cost from getScoutCost (pulse: 7). Matches the server-of-record in
	// scout-beat-execute/index.ts:153, which ignores sourceMode/location. The
	// prod UI used to override to 10 for pulse+niche+location, but that was
	// cosmetic — actual decrement was always 7. We keep one source of truth.
	$: perRunCost = getScoutCost(scoutType, scoutType === 'social' ? platform : undefined);

	// Form state
	let regularity: RegularityType = scoutType === 'civic' ? 'monthly' : 'weekly';
	let dayNumber = 1;
	let hour = 8;
	let minute = 0;
	let period: 'AM' | 'PM' = 'AM';

	let isSubmitting = false;
	let errorMessage = '';
	let scheduleSuccess = false;
	export let sourceMode: 'reliable' | 'niche' = 'niche';
	export let excludedDomains: string[] = [];
	export let prioritySources: string[] = [];

	// Web scout: location/topic added at schedule time
	let selectedLocation: GeocodedLocation | null = null;
	let topicInput = topic;
	let existingTopics: string[] = [];

	// Timezone label
	let userTimezoneLabel =
		typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'Local time';

	$: userTimezoneLabel =
		$authStore.user?.timezone ||
		(typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : userTimezoneLabel);

	// Load existing topics for web scout scope dropdown
	onMount(async () => {
		try {
			const response: ActiveJobsResponse = await apiClient.getActiveJobs();
			const allScouts = response.scrapers || [];
			existingTopics = collectTopicCounts(allScouts).map(({ topic }) => topic);
		} catch (_e) {
			// Non-critical
		}
	});

	// Per DESIGN.md §2.3: scout-type tiles use primary (plum) by default;
	// social + civic use secondary (ochre) so the dashboard reads as a
	// two-surface split instead of four competing colors.
	type TileVariant = 'primary' | 'secondary';
	const scoutTypeInfo: Record<ScoutType, {
		title: string;
		scheduleTitle: string;
		description: string;
		tile: TileVariant;
		icon: typeof Bell;
		notifyRule: string;
	}> = {
		pulse: {
			title: m.scoutTypeInfo_newsPulse_title(),
			scheduleTitle: m.scheduleSearch_title(),
			description: m.scoutTypeInfo_newsPulse_description(),
			tile: 'primary',
			icon: Bell,
			notifyRule: m.scoutTypeInfo_newsPulse_notifyRule()
		},
		web: {
			title: m.scoutTypeInfo_web_title(),
			scheduleTitle: m.scheduleSearch_titlePageScout(),
			description: m.scoutTypeInfo_web_description(),
			tile: 'primary',
			icon: ScanSearch,
			notifyRule: m.scoutTypeInfo_web_notifyRule()
		},
		social: {
			title: m.scoutTypeInfo_social_title(),
			scheduleTitle: m.scheduleSearch_titleSocialScout(),
			description: m.scoutTypeInfo_social_description(),
			tile: 'secondary',
			icon: Users,
			notifyRule: m.scoutTypeInfo_social_notifyRule()
		},
		civic: {
			title: m.scoutTypeInfo_civic_title(),
			scheduleTitle: m.scheduleSearch_titleCivicScout(),
			description: m.scoutTypeInfo_civic_description(),
			tile: 'secondary',
			icon: Landmark,
			notifyRule: m.scoutTypeInfo_civic_notifyRule()
		},
		// Placeholder until the Transport panel ships its own modal copy —
		// no UI creation path reaches this modal with type 'transport' yet.
		transport: {
			title: m.scoutTypeInfo_web_title(),
			scheduleTitle: m.scheduleSearch_title(),
			description: m.scoutTypeInfo_web_description(),
			tile: 'primary',
			icon: Bell,
			notifyRule: m.scoutTypeInfo_web_notifyRule()
		}
	};

	const daysOfWeek = [
		{ value: 1, label: m.schedule_monday() },
		{ value: 2, label: m.schedule_tuesday() },
		{ value: 3, label: m.schedule_wednesday() },
		{ value: 4, label: m.schedule_thursday() },
		{ value: 5, label: m.schedule_friday() },
		{ value: 6, label: m.schedule_saturday() },
		{ value: 7, label: m.schedule_sunday() }
	];

	$: info = scoutTypeInfo[scoutType];
	$: if ((scoutType === 'pulse' || scoutType === 'social') && regularity === 'daily') regularity = 'weekly';
	$: if (scoutType === 'civic' && regularity !== 'monthly') regularity = 'monthly';
	$: monthlyCost = regularity === 'daily' ? perRunCost * 30 : regularity === 'weekly' ? perRunCost * 4 : perRunCost;

	$: preFormDisclaimers = scoutType === 'web'
		? [
			{ icon: Mail, text: webCriteria ? m.schedule_emailDisclaimer_webCriteria() : m.schedule_emailDisclaimer_webAny() },
			{ icon: ScanSearch, text: 'Scheduling saves the current page as a baseline. Inbox units appear only after later changes.' }
		]
		: [];

	$: postFormDisclaimers =
		scoutType === 'pulse' ? [{ icon: Mail, text: m.schedule_emailDisclaimer_pulse() }] :
		scoutType === 'social' ? [{ icon: Mail, text: m.schedule_emailDisclaimer_social() }] :
		[];

	function getScheduleSummary(): string {
		let h = hour;
		if (period === 'AM' && h === 12) h = 0;
		else if (period === 'PM' && h !== 12) h += 12;
		const time24h = `${h.toString().padStart(2, '0')}:${(minute ?? 0).toString().padStart(2, '0')}`;

		if (regularity === 'daily') {
			return `Daily at ${time24h}`;
		} else if (regularity === 'weekly') {
			const dayName = daysOfWeek.find(d => d.value === dayNumber)?.label || 'Monday';
			return `Every ${dayName} at ${time24h}`;
		} else {
			return `Monthly on day ${dayNumber} at ${time24h}`;
		}
	}

	async function handleSubmit(event: Event) {
		event.preventDefault();

		if (!scoutName.trim()) {
			errorMessage = m.scheduleSearch_nameRequired();
			return;
		}

		// Validation for web scouts: need URL
		if (scoutType === 'web' && !url.trim()) {
			errorMessage = m.scheduleSearch_urlRequired();
			return;
		}

		const hasTopic = !!topicInput.trim();
		const hasLocation = !!(selectedLocation || location);
		if (!hasTopic && !hasLocation) {
			errorMessage = 'Add at least one topic tag or location before scheduling.';
			return;
		}

		// Validation for pulse: need location or criteria
		if (scoutType === 'pulse' && !location && !criteria) {
			errorMessage = m.scheduleSearch_locationOrTopicRequired();
			return;
		}

		// Validation for social: need profile handle
		if (scoutType === 'social' && !profile_handle.trim()) {
			errorMessage = 'Profile handle is required';
			return;
		}

		// Validation for civic: need council domain + selected listing pages
		if (scoutType === 'civic') {
			if (!root_domain.trim()) {
				errorMessage = 'Council website is required';
				return;
			}
			if (!tracked_urls.length) {
				errorMessage = 'Select at least one page to monitor before scheduling';
				return;
			}
		}

		isSubmitting = true;
		errorMessage = '';


		// Compute time
		let computedHour = hour;
		if (period === 'AM' && computedHour === 12) computedHour = 0;
		else if (period === 'PM' && computedHour !== 12) computedHour += 12;
		const computedTime = `${computedHour.toString().padStart(2, '0')}:${(minute ?? 0).toString().padStart(2, '0')}`;

		// Schedule the scout and dispatch success only after API completes
		let schedulePromise: Promise<unknown>;
		if (scoutType === 'web') {
			schedulePromise = apiClient.scheduleMonitoring({
				name: scoutName.trim(),
				url,
				criteria: webCriteria,
				channel: 'website' as ScrapeChannel,
				regularity,
				day_number: regularity === 'daily' ? 1 : dayNumber,
				time: computedTime,
				monitoring: 'EMAIL',
				location: selectedLocation || undefined,
				topic: topicInput.trim() || undefined,
				content_hash: contentHash,
				provider
			});
		} else if (scoutType === 'social') {
			schedulePromise = apiClient.scheduleLocalScout({
				name: scoutName.trim(),
				scout_type: 'social',
				regularity,
				day_number: dayNumber,
				time: computedTime,
				monitoring: 'EMAIL',
				criteria: criteria || undefined,
				platform,
				profile_handle: profile_handle.trim(),
				monitor_mode,
				track_removals: trackRemovals,
				baseline_posts: baselinePosts.length ? baselinePosts : undefined,
				topic: topicInput.trim() || undefined
			});
		} else if (scoutType === 'civic') {
			schedulePromise = apiClient.scheduleLocalScout({
				name: scoutName.trim(),
				scout_type: 'civic',
				regularity,
				day_number: dayNumber,
				time: computedTime,
				monitoring: 'EMAIL',
				location: selectedLocation || undefined,
				root_domain: root_domain || undefined,
				tracked_urls: tracked_urls.length ? tracked_urls : undefined,
				topic: topicInput.trim() || undefined,
				criteria: criteria || undefined,
				initial_promises: initialPromises.length ? initialPromises : undefined
			});
		} else {
			schedulePromise = apiClient.scheduleLocalScout({
				name: scoutName.trim(),
				scout_type: scoutType,
				regularity,
				day_number: dayNumber,
				time: computedTime,
				monitoring: 'EMAIL',
				location: location || undefined,
				topic: topicInput.trim() || undefined,
				criteria: criteria || undefined,
				source_mode: sourceMode,
				excluded_domains: excludedDomains.length ? excludedDomains : undefined,
				priority_sources: prioritySources.length ? prioritySources : undefined
			});
		}

		schedulePromise.then(() => {
			scheduleSuccess = true;
			isSubmitting = false;
			onSuccess({ name: scoutName, scoutType });
			authStore.refreshUser();
		}).catch((error) => {
			isSubmitting = false;
			errorMessage = error instanceof Error ? error.message : 'Failed to schedule scout';
		});
	}

	function handleClose() {
		onClose();
		if (scoutType !== 'web') scoutName = '';
		errorMessage = '';
		scheduleSuccess = false;
		selectedLocation = null;
		topicInput = '';
	}

	function handleBackdropClick(event: MouseEvent) {
		if (event.target === event.currentTarget) {
			handleClose();
		}
	}

	function handleLocationSelect(location: GeocodedLocation) {
		selectedLocation = location;
	}

	function handleLocationClear() {
		selectedLocation = null;
	}
</script>

{#if open}
	<!-- svelte-ignore a11y-click-events-have-key-events -->
	<!-- svelte-ignore a11y-no-static-element-interactions -->
	<div
		class="modal-backdrop"
		on:click={handleBackdropClick}
		on:keydown={(event) => event.key === 'Escape' && handleClose()}
	>
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
		<form
			class="modal-panel"
			on:submit={handleSubmit}
			on:click|stopPropagation
			on:keydown|stopPropagation
			aria-labelledby="scout-schedule-title"
		>
			{#if scheduleSuccess}
				<div class="success" transition:fade={{ duration: 200 }}>
					<div class="success-icon">
						<CheckCircle size={28} />
					</div>
					<h3 class="success-title">{m.scheduleSearch_scoutScheduled()}</h3>
					<p class="success-name">{scoutName}</p>
					<p class="success-summary">{getScheduleSummary()}</p>
				</div>
				<footer class="modal-footer">
					<button type="button" class="btn-primary" on:click={handleClose}>
						{m.common_done()}
					</button>
				</footer>
			{:else}
				<header class="modal-header">
					<div
						class="modal-icon-tile"
						class:modal-icon-tile--secondary={info.tile === 'secondary'}
					>
						<svelte:component this={info.icon} size={18} />
					</div>
					<div class="modal-header-text">
						<h2 id="scout-schedule-title" class="modal-title">{info.scheduleTitle}</h2>
						<p class="modal-subtitle">{info.description}</p>
					</div>
					<button type="button" class="modal-close" on:click={handleClose} aria-label="Close modal">
						<X size={16} />
					</button>
				</header>

				<div class="modal-body">
					{#if (scoutType === 'web' && url) || (scoutType === 'web' && webCriteria) || (scoutType === 'pulse' && (location || criteria)) || (scoutType === 'pulse' && (excludedDomains.length || prioritySources.length)) || (scoutType === 'social' && profile_handle) || (scoutType === 'civic' && (root_domain || tracked_urls.length))}
						<div class="context-block">
							{#if scoutType === 'web' && url}
								<div class="context-row">
									<Globe size={14} class="context-icon" />
									<span class="context-key">URL:</span>
									<span class="context-value truncate">{url}</span>
								</div>
							{/if}
							{#if scoutType === 'web' && webCriteria}
								<div class="context-row">
									<Filter size={14} class="context-icon" />
									<span class="context-key">{m.scheduleSearch_criteriaLabel()}</span>
									<span class="context-value italic">{webCriteria}</span>
								</div>
							{/if}
							{#if location && scoutType === 'pulse'}
								<div class="context-row">
									<MapPin size={14} class="context-icon" />
									<span class="context-key">{m.scheduleSearch_locationLabel()}</span>
									<span class="context-value">{location.displayName}</span>
								</div>
							{/if}
							{#if criteria && scoutType === 'pulse'}
								<div class="context-row">
									<Tag size={14} class="context-icon" />
									<span class="context-key">{m.scheduleSearch_searchLabel()}</span>
									<span class="context-value">{criteria}</span>
								</div>
							{/if}
							{#if excludedDomains.length > 0 && scoutType === 'pulse'}
								<div class="context-row context-row-divider">
									<Ban size={14} class="context-icon" />
									<span class="context-key">{m.pulse_excludedDomains()}:</span>
									<span class="context-value">{excludedDomains.join(', ')}</span>
								</div>
							{/if}
							{#if prioritySources.length > 0 && scoutType === 'pulse'}
								<div class="context-row context-row-divider">
									<Star size={14} class="context-icon" />
									<span class="context-key">{m.pulse_prioritySources()}:</span>
									<span class="context-value">{prioritySources.join(', ')}</span>
								</div>
							{/if}
							{#if scoutType === 'social' && profile_handle}
								<div class="context-row">
									<Users size={14} class="context-icon" />
									<span class="context-key">{m.socialScout_handleLabel()}:</span>
									<span class="context-value">@{profile_handle} ({platform})</span>
								</div>
							{/if}
							{#if scoutType === 'civic' && root_domain}
								<div class="context-row">
									<Globe size={14} class="context-icon" />
									<span class="context-key">{m.civic_monitorTitle()}:</span>
									<span class="context-value">{root_domain}</span>
								</div>
							{/if}
							{#if scoutType === 'civic' && tracked_urls.length > 0}
								<div class="context-row">
									<ScanSearch size={14} class="context-icon" />
									<span class="context-key">{m.civic_selectUrls()}:</span>
									<span class="context-value">{tracked_urls.length} URLs</span>
								</div>
							{/if}
						</div>
					{/if}

					{#each preFormDisclaimers as d}
						<p class="info-note">
							<svelte:component this={d.icon} size={14} />
							<span>{d.text}</span>
						</p>
					{/each}

					{#if scoutType === 'web' || scoutType === 'civic'}
						<div class="form-field">
							<span class="form-label">{m.filter_locationLabel()}</span>
							<LocationAutocomplete
								selectedLocation={selectedLocation}
								onSelect={handleLocationSelect}
								onClear={handleLocationClear}
							/>
						</div>
					{/if}

					<div class="form-field">
						<span class="form-label">{m.schedule_categoryLabel()}</span>
						<TopicChips
							bind:topic={topicInput}
							{existingTopics}
							placeholder={m.schedule_categoryPlaceholder()}
						/>
					</div>

					<!-- Web scouts set scoutName upstream in PageScoutView; skip here. -->
					{#if scoutType !== 'web'}
						<div class="form-field">
							<label for="scout-name" class="form-label">
								{m.scout_name()} <span class="required-star">*</span>
							</label>
							<input
								id="scout-name"
								type="text"
								bind:value={scoutName}
								maxlength="30"
								placeholder={m.scheduleSearch_scoutNamePlaceholder()}
								required
								class="form-input"
							/>
							<p class="form-helper helper-row">
								<span>{m.scout_nameHint()}</span>
								<span class={scoutName.length > 25 ? 'count--warn' : ''}>{scoutName.length}/30</span>
							</p>
						</div>
					{/if}

					<div class="form-field">
						<div class="label-row">
							<label for="regularity" class="form-label">
								{m.scheduleSearch_monitoringFrequency()}
							</label>
							{#if import.meta.env.PUBLIC_DEPLOYMENT_TARGET !== 'supabase'}
								<span class="cost-pill">
									{monthlyCost === 1 ? m.scout_monthlyCost({ count: monthlyCost }) : m.scout_monthlyCostPlural({ count: monthlyCost })}
								</span>
							{/if}
						</div>
						<select
							id="regularity"
							bind:value={regularity}
							class="form-select"
							disabled={scoutType === 'civic'}
						>
							{#if scoutType === 'web'}
								<option value="daily">{m.schedule_daily()}</option>
							{/if}
							{#if scoutType !== 'civic'}
								<option value="weekly">{m.schedule_weekly()}</option>
							{/if}
							<option value="monthly">{m.schedule_monthly()}</option>
						</select>
					</div>

					{#if regularity === 'weekly'}
						<div class="form-field">
							<label for="day-of-week" class="form-label">{m.schedule_dayOfWeek()}</label>
							<select id="day-of-week" bind:value={dayNumber} class="form-select">
								{#each daysOfWeek as day}
									<option value={day.value}>{day.label}</option>
								{/each}
							</select>
						</div>
					{:else if regularity === 'monthly'}
						<div class="form-field">
							<label for="day-of-month" class="form-label">{m.schedule_dayOfMonth()}</label>
							<input
								id="day-of-month"
								type="number"
								bind:value={dayNumber}
								min="1"
								max="31"
								class="form-input"
							/>
							<p class="form-helper">{m.schedule_dayOfMonthHint()}</p>
						</div>
					{/if}

					<TimePicker
						bind:hour
						bind:minute
						bind:period
						timezoneLabel={userTimezoneLabel}
					/>

					{#each postFormDisclaimers as d}
						<p class="info-note">
							<svelte:component this={d.icon} size={14} />
							<span>{d.text}</span>
						</p>
					{/each}

					{#if errorMessage}
						<p class="error-text">{errorMessage}</p>
					{/if}
				</div>

				<footer class="modal-footer">
					<button type="button" class="btn-secondary" on:click={handleClose}>
						{m.common_cancel()}
					</button>
					<button type="submit" class="btn-primary" disabled={isSubmitting}>
						{#if isSubmitting}
							<svg class="btn-spinner" viewBox="0 0 24 24" aria-hidden="true">
								<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none" opacity="0.25"></circle>
								<path fill="currentColor" opacity="0.75" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
							</svg>
							<span>{m.common_scheduling()}</span>
						{:else}
							<span>{m.scout_scheduleScout()}</span>
						{/if}
					</button>
				</footer>
			{/if}
		</form>
	</div>
{/if}


<style>
	.context-block {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		padding: 0.75rem 0.875rem;
		margin-bottom: 1rem;
	}

	.context-row {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		font-size: 0.8125rem;
		line-height: 1.5;
		color: var(--color-ink-muted);
	}

	.context-row-divider {
		margin-top: 0.375rem;
		padding-top: 0.5rem;
		border-top: 1px solid var(--color-border);
	}

	.context-row :global(.context-icon) {
		color: var(--color-ink-subtle);
		flex-shrink: 0;
		margin-top: 0.1875rem;
	}

	.context-key {
		font-weight: 600;
		color: var(--color-ink);
	}

	.context-value {
		color: var(--color-ink-muted);
		min-width: 0;
		overflow: hidden;
	}

	.truncate {
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.italic {
		font-style: italic;
	}

	.info-note {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		margin: 0 0 1rem 0;
		padding: 0.5rem 0.75rem;
		background: var(--color-secondary-soft);
		border-left: 3px solid var(--color-secondary);
		color: var(--color-ink);
		font-size: 0.8125rem;
		line-height: 1.5;
	}

	.info-note :global(svg) {
		flex-shrink: 0;
		margin-top: 0.125rem;
		color: var(--color-secondary);
	}

	.label-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 0.375rem;
	}

	.label-row .form-label {
		margin-bottom: 0;
	}

	.required-star {
		color: var(--color-error);
	}

	.helper-row {
		display: flex;
		justify-content: space-between;
	}

	.count--warn {
		color: var(--color-warning);
	}

	/* Pills are the only allowed radius per DESIGN.md §1. */
	.cost-pill {
		display: inline-flex;
		align-items: center;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		padding: 0.125rem 0.5rem;
		color: var(--color-secondary);
		background: var(--color-secondary-soft);
		border: 1px solid var(--color-secondary);
		border-radius: 9999px;
	}

	.error-text {
		margin: 1rem 0 0 0;
		padding: 0.5rem 0.75rem;
		background: rgba(179, 62, 46, 0.08);
		border-left: 3px solid var(--color-error);
		color: var(--color-error);
		font-size: 0.8125rem;
	}

	.success {
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 2.5rem 1.5rem;
		gap: 0.75rem;
	}

	.success-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 3rem;
		height: 3rem;
		background: rgba(47, 143, 95, 0.12);
		color: var(--color-success);
		border: 1px solid var(--color-success);
	}

	.success-title {
		font-family: var(--font-display);
		font-size: 1.25rem;
		font-weight: 600;
		color: var(--color-ink);
		margin: 0;
		letter-spacing: -0.01em;
	}

	.success-name {
		font-size: 0.9375rem;
		color: var(--color-ink-muted);
		margin: 0;
		text-align: center;
	}

	.success-summary {
		font-size: 0.8125rem;
		color: var(--color-ink-subtle);
		margin: 0;
		text-align: center;
	}

	.btn-spinner {
		height: 1rem;
		width: 1rem;
		animation: spin 1s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>

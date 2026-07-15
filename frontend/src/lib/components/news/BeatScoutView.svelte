<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { locationStore } from '$lib/stores/location';
	import { pulseStore } from '$lib/stores/pulse';
	import AINewsCard from './AINewsCard.svelte';
	import LocationAutocomplete from '$lib/components/ui/LocationAutocomplete.svelte';

	import FormPanel from '$lib/components/ui/FormPanel.svelte';
	import CriteriaInput from '$lib/components/ui/CriteriaInput.svelte';
	import StepButtons from '$lib/components/ui/StepButtons.svelte';
	import TogglePicker from '$lib/components/ui/TogglePicker.svelte';
	import ScoutScheduleModal from '$lib/components/modals/ScoutScheduleModal.svelte';
	import { Clock, Building2, Lightbulb, ChevronDown, ChevronUp, RotateCcw, Sparkles, Ban, Star } from 'lucide-svelte';

	import ProgressIndicator from '$lib/components/ui/ProgressIndicator.svelte';
	import type { GeocodedLocation, ActiveJobsResponse } from '$lib/types';
	import { apiClient } from '$lib/api-client';
	import { addRecentLocation } from '$lib/stores/recent-locations';
	import { marked, Renderer } from 'marked';
	import { safeHtml } from '$lib/utils/sanitize';
	import { parseExcludedDomains, parsePrioritySources } from '$lib/utils/domains';
	import { easeOutProgress, formatEstimatedTime, PULSE_EXPECTED_DURATION_MS } from '$lib/utils/progress-timer';
	import { buildBeatScoutScheduleDraft, buildBeatScoutSearchRequest } from './beat-scout';
	import * as m from '$lib/paraglide/messages';

	export let onScheduled: (detail: { scoutType: 'pulse' }) => void = () => {};

	// Custom renderer to show external link icon instead of link text
	const renderer = new Renderer();
	renderer.link = ({ href, title, text }) => {
		const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline;vertical-align:middle;margin-left:2px;opacity:0.7;"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
		const titleAttr = title ? ` title="${title}"` : '';
		return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${icon}</a>`;
	};

	marked.setOptions({ breaks: true, gfm: true, renderer });

	// Internal state
	let topicInput = '';

	let progress = 0;
	let progressMessage = '';
	let progressHintText = '';
	let progressTimer: ReturnType<typeof setInterval> | null = null;
	let progressStartTime = 0;

	// Schedule modal state
	let showScheduleModal = false;
	let searchCompleted = false;
	let searchError = '';

	// Prompt editing state
	let showPromptEditor = false;
	let editedNewsPrompt = '';
	let editedGovPrompt = '';

	// The current workspace route owns panel state directly; this view no
	// longer infers mode from the deleted sidebar UI.
	export let initialMode: 'location' | 'beat' = 'location';
	$: mode = initialMode;

	// Source mode — default depends on panel mode
	let sourceMode: 'reliable' | 'niche' = 'niche';
	let lastMode: 'location' | 'beat' = 'location';

	// Reset state when switching between panels
	$: if (mode !== lastMode) {
		lastMode = mode;
		sourceMode = mode === 'beat' ? 'reliable' : 'niche';
		topicInput = '';
		searchCompleted = false;
		pulseStore.reset();
	}

	// Excluded domains
	let excludedDomainsText = $pulseStore.excludedDomainsText || '';
	$: parsedExcludedDomains = parseExcludedDomains(excludedDomainsText);

	// Priority sources
	let prioritySourcesText = $pulseStore.prioritySourcesText || '';
	$: parsedPrioritySources = parsePrioritySources(prioritySourcesText);


	// Derive selected location from store
	$: selectedLocation = $locationStore;

	// Existing topics from user's scouts (for dropdown)


	onMount(async () => {
		editedNewsPrompt = $pulseStore.customFilterPrompts.news || '';
		editedGovPrompt = $pulseStore.customFilterPrompts.government || '';

		try {
			const response: ActiveJobsResponse = await apiClient.getActiveJobs();
			const allScouts = response.scrapers || [];


			const seen = new Set<string>();
			for (const scout of allScouts) {
				const key = scout.location?.maptilerId ?? scout.location?.displayName;
				if (scout.location && key && !seen.has(key)) {
					seen.add(key);
					addRecentLocation(scout.location);
				}
			}

			if (!$locationStore) {
				const firstLocationScout = allScouts.find(s => s.location);
				if (firstLocationScout?.location) {
					locationStore.setLocation(firstLocationScout.location);
				}
			}
		} catch (e) {
			// Non-critical
		}
	});

	// isTopicOnly drives category selection (analysis vs government) and AI settings labels
	$: isTopicOnly = mode === 'beat';

	// Default prompts based on scope
	const DEFAULT_NEWS_PROMPT = `Surface niche content a local journalist wouldn't find on their own. AIM FOR 5-6 ARTICLES.

PRIORITY ORDER:
1. Community blogs and neighborhood sites
2. Cultural organizations, local associations, civic groups
3. Specialized or independent local publications (not mainstream outlets)
4. News stories covered by only 1-2 outlets (underreported)

SOURCE DIVERSITY:
- AVOID mainstream national/international news outlets
- AVOID selecting more than 2 articles from the same domain
- PREFER sources with local country domains in the local language

EXCLUDE: Companies named after the city, different places with same name, press releases, paywalled content.`;

	const DEFAULT_GOV_PROMPT = `Select GOVERNMENT and MUNICIPAL articles. AIM FOR 5-6 ARTICLES.

PRIORITY ORDER:
1. City council meetings and decisions
2. Municipal services and public works announcements
3. Local elections and officials news
4. Permits, zoning, and regulations
5. Mayor/city official statements

EXCLUDE: National politics unless directly affecting the city.`;

	const DEFAULT_TOPIC_NEWS_PROMPT = `Surface niche content a journalist wouldn't find on their own. AIM FOR 5-6 ARTICLES.

PRIORITY ORDER:
1. Specialized blogs and independent publications
2. Community organizations, advocacy groups, and civic initiatives
3. Underreported stories covered by only 1-2 outlets
4. Analysis or investigative pieces from non-mainstream sources

SOURCE DIVERSITY:
- AVOID mainstream national/international news outlets
- AVOID selecting more than 2 articles from the same domain
- PREFER niche publications, expert sources, and independent analysis

EXCLUDE: Articles that merely mention the topic in passing, press releases, paywalled content.`;

	const DEFAULT_TOPIC_ANALYSIS_PROMPT = `Select ANALYSIS and INSIGHT articles. AIM FOR 5-6 ARTICLES.

PRIORITY ORDER:
1. Blog posts and long-form analysis
2. Research papers and reports
3. Expert opinion and commentary
4. Deep-dive investigative pieces

EXCLUDE: Breaking news already covered in the news section, press releases without analysis.`;

	$: activeNewsPlaceholder = isTopicOnly ? DEFAULT_TOPIC_NEWS_PROMPT : DEFAULT_NEWS_PROMPT;
	$: activeGovPlaceholder = isTopicOnly ? DEFAULT_TOPIC_ANALYSIS_PROMPT : DEFAULT_GOV_PROMPT;

	$: isLoading = $pulseStore.isLoading;

	function saveNewsPrompt() {
		pulseStore.setCustomFilterPrompt('news', editedNewsPrompt.trim() || null);
	}

	function saveGovPrompt() {
		pulseStore.setCustomFilterPrompt('government', editedGovPrompt.trim() || null);
	}

	function resetPrompts() {
		editedNewsPrompt = '';
		editedGovPrompt = '';
		excludedDomainsText = '';
		prioritySourcesText = '';
		pulseStore.resetCustomFilterPrompts();
	}

	// Progress animation
	function startProgress() {
		progressStartTime = Date.now();
		progress = 2;
		progressMessage = m.pulse_progressSearching({ location: selectedLocation?.displayName || topicInput || 'location' });
		progressHintText = '';

		if (progressTimer) clearInterval(progressTimer);

		progressTimer = setInterval(() => {
			if (!$pulseStore.isLoading) return;

			const elapsed = Date.now() - progressStartTime;
			progress = easeOutProgress(elapsed, PULSE_EXPECTED_DURATION_MS);

			if (progress < 25) progressMessage = m.pulse_progressSearching({ location: selectedLocation?.displayName || topicInput || 'location' });
			else if (progress < 55) progressMessage = m.pulse_progressAnalyzing();
			else if (progress < 80) progressMessage = m.pulse_progressFiltering();
			else progressMessage = m.pulse_progressPreparing();

			const remainingMs = Math.max(0, PULSE_EXPECTED_DURATION_MS - elapsed);
			const estimate = formatEstimatedTime(remainingMs);
			if (estimate.type === 'done') {
				progressHintText = m.pulse_almostDone();
			} else if (estimate.type === 'minutes') {
				progressHintText = m.pulse_estimatedTimeMinutes({ minutes: estimate.value });
			} else {
				progressHintText = m.pulse_estimatedTimeSeconds({ seconds: estimate.value });
			}
		}, 500);
	}

	function stopProgress(success: boolean) {
		progress = success ? 100 : 0;
		progressMessage = success ? m.pulse_progressComplete() : '';
		progressHintText = '';
		if (progressTimer) {
			clearInterval(progressTimer);
			progressTimer = null;
		}
	}

	// Location handlers
	function handleLocationSelect(location: GeocodedLocation) {
		locationStore.setLocation(location);
	}

	function handleLocationClear() {
		locationStore.clear();
	}

	// canSearch: location mode needs location, beat mode needs criteria
	$: canSearch = mode === 'location'
		? !!selectedLocation
		: !!topicInput.trim();

	// Search handler
	async function handleSearch() {
		if (!canSearch) return;

		try {
			searchError = '';
			startProgress();
			const request = buildBeatScoutSearchRequest({
				mode,
				sourceMode,
				topicInput,
				selectedLocation,
				excludedDomains: parsedExcludedDomains,
				prioritySources: parsedPrioritySources
			});
			if (!request) return;

			await pulseStore.fetchBothCategories(
				request.location,
				sourceMode,
				request.criteria,
				request.excludedDomains,
				request.prioritySources
			);

			stopProgress(true);
			searchCompleted = true;
		} catch (error) {
			console.error('[BeatScoutView] Search error:', error);
			searchError = error instanceof Error ? error.message : 'Search failed. Please try again.';
			stopProgress(false);
			searchCompleted = false;
		}
	}

	onDestroy(() => {
		if (progressTimer) {
			clearInterval(progressTimer);
			progressTimer = null;
		}
	});

	function formatTime(ms: number | null): string {
		if (!ms) return '';
		return `${Math.round(ms / 1000)}s`;
	}

	$: hasResults = $pulseStore.newsArticles.length > 0 || $pulseStore.govArticles.length > 0;
	$: totalArticles = $pulseStore.newsArticles.length + $pulseStore.govArticles.length;
	$: totalFound = $pulseStore.newsTotalResults + $pulseStore.govTotalResults;

	// Dynamic title/subtitle
	$: formTitle = (() => {
		if (isTopicOnly) return m.pulse_titleTopic();
		return topicInput.trim() ? m.pulse_titleBoth() : m.pulse_titleLocation();
	})();

	$: formSubtitle = (() => {
		if (isTopicOnly) return m.pulse_subtitleTopic();
		return topicInput.trim() ? m.pulse_subtitleBoth() : m.pulse_subtitleLocation();
	})();

	$: scheduleDraft = buildBeatScoutScheduleDraft(selectedLocation, topicInput);
</script>

<div class="panel-view">
	<div class="two-column-layout">
		<!-- Left Column: Form -->
		<div class="query-column">
			<FormPanel
				badge={m.modal_beatScoutBadge()}
				title={formTitle}
				subtitle={formSubtitle}
			>
				{#if mode === 'location'}
					<!-- Location (required) -->
					<div class="field-group">
						<div class="field-label">{m.filter_locationLabel()}</div>
						<LocationAutocomplete
							selectedLocation={selectedLocation}
							onSelect={handleLocationSelect}
							onClear={handleLocationClear}
						/>
					</div>
				{:else}
					<!-- Criteria (required for beat mode) -->
					<div class="field-group">
						<label for="smart-criteria" class="field-label">
							{m.beatScout_criteriaLabel()}
						</label>
						<CriteriaInput
							bind:value={topicInput}
							placeholder={m.webScout_criteriaPlaceholder()}
							rows={2}
							examples={[
								{ label: 'housing policy', value: 'housing policy' },
								{ label: 'renewable energy', value: 'renewable energy' },
								{ label: 'local elections', value: 'local elections' },
							]}
						/>
						{#if topicInput.trim() && topicInput.trim().split(/\s+/).length <= 2}
							<p class="scope-hint">{m.beatScout_broadCriteriaHint()}</p>
						{/if}
					</div>

					<div class="field-group">
						<div class="field-label">
							{m.filter_locationLabel()}
							<span class="field-subtitle">{m.common_optional()}</span>
						</div>
						<p class="field-hint">{m.beatScout_optionalLocationLabel()}</p>
						<LocationAutocomplete
							selectedLocation={selectedLocation}
							onSelect={handleLocationSelect}
							onClear={handleLocationClear}
						/>
					</div>
				{/if}

				<!-- Sources Toggle -->
				<div class="field-group">
					<div class="field-label">{m.sourceMode_label()}</div>
					<TogglePicker
						bind:value={sourceMode}
						options={[
							{ value: 'reliable', label: m.sourceMode_reliable(), description: m.sourceMode_reliableDesc() },
							{ value: 'niche', label: m.sourceMode_niche(), description: m.sourceMode_nicheDesc() }
						]}
					/>
					{#if sourceMode === 'niche'}
						<p class="niche-disclaimer">{m.disclaimer_nicheWarning()}</p>
					{/if}
				</div>

				<!-- Optional criteria for location mode (hidden when niche: results are poor with niche + criteria) -->
				{#if mode === 'location' && sourceMode !== 'niche'}
					<div class="field-group">
						<label for="smart-criteria" class="field-label">
							{m.beatScout_criteriaLabel()}
							<span class="field-subtitle">{m.beatScout_criteriaOptionalHint()}</span>
						</label>
						<CriteriaInput
							bind:value={topicInput}
							placeholder={m.webScout_criteriaPlaceholder()}
							rows={2}
							examples={[
								{ label: 'housing policy', value: 'housing policy' },
								{ label: 'renewable energy', value: 'renewable energy' },
								{ label: 'local elections', value: 'local elections' },
							]}
						/>
					</div>
				{/if}

				<hr class="form-divider" />

				<!-- AI Settings (advanced) -->
				<div class="prompt-section">
					<button
						class="prompt-toggle"
						on:click={() => showPromptEditor = !showPromptEditor}
						type="button"
					>
						<span class="prompt-toggle-label">{m.pulse_aiResearchSettings()}</span>
						{#if showPromptEditor}
							<ChevronUp size={14} />
						{:else}
							<ChevronDown size={14} />
						{/if}
					</button>

					{#if showPromptEditor}
						<div class="prompt-editor">
							<div class="prompt-group">
								<label class="prompt-label">
									<Sparkles size={12} />
									{m.pulse_newsFilter()}
								</label>
								<textarea
									class="prompt-textarea"
									bind:value={editedNewsPrompt}
									on:blur={saveNewsPrompt}
									placeholder={activeNewsPlaceholder}
									rows="6"
								></textarea>
							</div>

							{#if !(mode === 'location' && sourceMode === 'niche')}
							<div class="prompt-group">
								<label class="prompt-label">
									{#if isTopicOnly}
										<Lightbulb size={12} />
										{m.pulse_analysisFilter()}
									{:else}
										<Building2 size={12} />
										{m.pulse_governmentFilter()}
									{/if}
								</label>
								<textarea
									class="prompt-textarea"
									bind:value={editedGovPrompt}
									on:blur={saveGovPrompt}
									placeholder={activeGovPlaceholder}
									rows="6"
								></textarea>
							</div>

							{/if}

							<div class="prompt-group">
								<label class="prompt-label">
									<Ban size={12} />
									{m.pulse_excludedDomains()}
								</label>
								<textarea
									class="prompt-textarea excluded-domains-textarea"
									bind:value={excludedDomainsText}
									on:blur={() => pulseStore.setExcludedDomains(excludedDomainsText, parsedExcludedDomains)}
									placeholder={m.pulse_excludedDomainsPlaceholder()}
									rows="3"
								></textarea>
							</div>

							<div class="prompt-group">
								<label class="prompt-label">
									<Star size={12} />
									{m.pulse_prioritySources()}
								</label>
								<textarea
									class="prompt-textarea excluded-domains-textarea"
									bind:value={prioritySourcesText}
									on:blur={() => pulseStore.setPrioritySources(prioritySourcesText, parsedPrioritySources)}
									placeholder={m.pulse_prioritySourcesPlaceholder()}
									rows="3"
								></textarea>
							</div>

							<button
								class="reset-button"
								on:click={resetPrompts}
								type="button"
							>
								<RotateCcw size={12} />
								{m.pulse_resetToDefaults()}
							</button>
						</div>
					{/if}
				</div>

				{#if searchError}
					<div class="error-block">{searchError}</div>
				{/if}

				<StepButtons
					step1Disabled={!canSearch || isLoading}
					step1Loading={isLoading}
					step1Label={m.pulse_startSearch()}
					step1LoadingLabel={m.common_searching()}
					step1Icon={Sparkles}
					step2Enabled={searchCompleted && canSearch}
					onStep1={handleSearch}
					onStep2={() => showScheduleModal = true}
				/>
			</FormPanel>
		</div>

		<!-- Right Column: Results -->
		<div class="results-column">
			{#if isLoading}
				<ProgressIndicator
					{progress}
					message={progressMessage || m.pulse_startingSearch()}
					state="loading"
					hintText={progressHintText || m.progress_expectUpToMinute()}
				/>
			{:else if hasResults}
				<section class="results-section">
					<div class="results-header">
						<div class="results-header-copy">
							<p class="results-eyebrow">{m.pulse_selectedByAI()}</p>
							<div class="results-count">
								<span class="count-number">{totalArticles}</span>
								<span class="count-label">{m.pulse_fromFound({ count: totalFound })}</span>
							</div>
						</div>
						{#if $pulseStore.processingTimeMs}
							<div class="results-meta">
								<Clock size={12} />
								<span>{formatTime($pulseStore.processingTimeMs)}</span>
							</div>
						{/if}
					</div>

					<!-- Structured Summary -->
					{#if $pulseStore.structuredSummary.news_summary || $pulseStore.structuredSummary.gov_summary}
						<div class="structured-summary">
							<p class="summary-eyebrow">{m.pulse_latestIn({ location: isTopicOnly ? topicInput : (selectedLocation?.displayName || 'Your Area') })}</p>
							<h3 class="summary-title">
								Editor Brief
							</h3>
							<div class="summary-stack">
							{#if $pulseStore.structuredSummary.news_summary}
								<section class="summary-section">
									<div class="summary-header">
										<span class="summary-label">
											<Sparkles size={12} />
											{m.pulse_news()}
										</span>
									</div>
									<div class="summary-text">{@html safeHtml(marked($pulseStore.structuredSummary.news_summary) as string)}</div>
								</section>
							{/if}
							{#if $pulseStore.structuredSummary.gov_summary}
								<section class="summary-section">
									<div class="summary-header">
										<span class="summary-label">
											{#if isTopicOnly}
												<Lightbulb size={12} />
												{m.pulse_analysisInsights()}
											{:else}
												<Building2 size={12} />
												{m.pulse_government()}
											{/if}
										</span>
									</div>
									<div class="summary-text">{@html safeHtml(marked($pulseStore.structuredSummary.gov_summary) as string)}</div>
								</section>
							{/if}
							</div>
						</div>
					{/if}

					<!-- News Section -->
					{#if $pulseStore.newsArticles.length > 0}
						<div class="category-section">
							<div class="category-header">
								<Sparkles size={16} class="category-icon" />
								<div class="category-heading">
									<p class="category-eyebrow">{m.pulse_news()}</p>
									<h4 class="category-title">{isTopicOnly ? m.pulse_newsUpdates() : m.pulse_localNews()}</h4>
								</div>
								<span class="category-count">{$pulseStore.newsArticles.length}</span>
							</div>
							<div class="articles-grid">
								{#each $pulseStore.newsArticles as article, i (article.url)}
									<div class="article-item">
										<AINewsCard {article} />
									</div>
								{/each}
							</div>
						</div>
					{/if}

					{#if $pulseStore.newsArticles.length > 0 && $pulseStore.govArticles.length > 0}
						<hr class="section-divider" />
					{/if}

					<!-- Government / Analysis Section -->
					{#if $pulseStore.govArticles.length > 0}
						<div class="category-section">
							<div class="category-header">
								{#if isTopicOnly}
									<Lightbulb size={16} class="category-icon" />
									<div class="category-heading">
										<p class="category-eyebrow">{m.pulse_analysisInsights()}</p>
										<h4 class="category-title">{m.pulse_analysisInsights()}</h4>
									</div>
								{:else}
									<Building2 size={16} class="category-icon" />
									<div class="category-heading">
										<p class="category-eyebrow">{m.pulse_government()}</p>
										<h4 class="category-title">{m.pulse_governmentMunicipal()}</h4>
									</div>
								{/if}
								<span class="category-count">{$pulseStore.govArticles.length}</span>
							</div>
							<div class="articles-grid">
								{#each $pulseStore.govArticles as article, i (article.url)}
									<div class="article-item">
										<AINewsCard {article} />
									</div>
								{/each}
							</div>
						</div>
					{/if}

					<!-- Search Queries Used -->
					{#if $pulseStore.searchQueriesUsed.length > 0}
						<div class="queries-info">
							<span class="queries-label">{m.pulse_searched()}</span>
							<div class="queries-list">
								{#each $pulseStore.searchQueriesUsed as query}
									<span class="query-tag">{query}</span>
								{/each}
							</div>
						</div>
					{/if}

					{#if $pulseStore.filteredOutCount > 0}
						<p class="filtered-disclaimer">{m.disclaimer_filteredCount({ count: $pulseStore.filteredOutCount })}</p>
					{/if}
				</section>
			{:else if searchCompleted}
				<div class="empty-state">
					<p class="empty-state-title">{m.pulse_emptyResults()}</p>
					<p class="empty-state-hint">{m.pulse_emptyResultsHint()}</p>
				</div>
			{/if}
		</div>
	</div>
</div>

<!-- Schedule Modal -->
<ScoutScheduleModal
	bind:open={showScheduleModal}
	scoutType="pulse"
	location={scheduleDraft.location}
	criteria={scheduleDraft.criteria}
	{sourceMode}
	excludedDomains={parsedExcludedDomains}
	prioritySources={parsedPrioritySources}
	onClose={() => showScheduleModal = false}
	onSuccess={() => {
		showScheduleModal = false;
		onScheduled({ scoutType: 'pulse' });
	}}
/>

<style>
	.form-divider { border: none; border-top: 1px solid rgba(0, 0, 0, 0.06); margin: 1.5rem 0 0.75rem; }

	.field-group { margin-bottom: 0.75rem; }
	.field-label { display: block; font-size: 0.8125rem; font-weight: 500; color: var(--color-ink); margin-bottom: 0.375rem; }
	.field-subtitle { font-weight: 400; color: var(--color-text-secondary); margin-left: 0.375rem; font-size: 0.8125rem; }
	.field-hint { font-size: 0.75rem; color: var(--color-ink-subtle); margin: 0 0 0.375rem; line-height: 1.4; }
	.niche-disclaimer { font-size: 0.75rem; color: var(--color-ink-subtle); margin: 0.375rem 0 0; line-height: 1.4; }
	.scope-hint { font-size: 0.75rem; color: var(--color-ink-subtle); margin: 0.375rem 0 0; line-height: 1.4; }
	.filtered-disclaimer { font-size: 0.75rem; color: var(--color-ink-subtle); margin: 0.75rem 0 0; line-height: 1.4; text-align: center; }
	.error-block { padding: 0.75rem; font-size: 0.8125rem; color: var(--color-error); background: color-mix(in oklab, var(--color-error) 10%, var(--color-card)); border: 1px solid color-mix(in oklab, var(--color-error) 32%, var(--color-border)); border-radius: var(--radius-md); margin-bottom: 1rem; }

	/* Prompt Editor Section */
	.prompt-section { margin-bottom: 1.5rem; }

	.prompt-toggle {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		padding: 0.625rem 0.75rem;
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		font-size: 0.75rem;
		color: var(--color-text-secondary);
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.prompt-toggle:hover { background: var(--color-surface); border-color: var(--color-accent); }
	.prompt-toggle-label { font-weight: 500; }

	.prompt-editor {
		margin-top: 0.75rem;
		padding: 1rem;
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
	}

	.prompt-group { margin-bottom: 1rem; }
	.prompt-group:last-of-type { margin-bottom: 0.75rem; }

	.prompt-label {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 0.6875rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--color-text-secondary);
		margin-bottom: 0.5rem;
	}

	.prompt-textarea {
		width: 100%;
		padding: 0.625rem;
		font-size: 0.75rem;
		line-height: 1.5;
		font-family: 'Monaco', 'Menlo', monospace;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		background: var(--color-surface-alt);
		resize: vertical;
		min-height: 100px;
	}

	.prompt-textarea:focus {
		outline: none;
		border-color: var(--color-accent);
		box-shadow: 0 0 0 2px rgba(var(--color-accent-rgb), 0.1);
	}

	.prompt-textarea::placeholder { color: var(--color-ink-subtle); font-size: 0.6875rem; }
	.excluded-domains-textarea { font-family: var(--font-body); min-height: 60px; }

	.reset-button {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.5rem 0.75rem;
		font-size: 0.6875rem;
		font-weight: 500;
		color: var(--color-text-secondary);
		background: var(--color-surface-alt);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.reset-button:hover { background: color-mix(in oklab, var(--color-error) 10%, transparent); border-color: color-mix(in oklab, var(--color-error) 40%, var(--color-border)); color: var(--color-error); }


	/* Empty State */
	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 3rem 1.5rem;
		text-align: center;
		color: var(--color-text-secondary);
	}
	.empty-state-title {
		font-size: 0.9375rem;
		font-weight: 500;
		margin: 0 0 0.5rem;
	}
	.empty-state-hint {
		font-size: 0.8125rem;
		margin: 0;
		color: var(--color-text-tertiary);
	}

	/* Results Section */
	.results-section {
		background: var(--color-surface-alt);
		border: 1px solid var(--color-border);
		padding: 1.5rem;
	}

	.results-header {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		margin-bottom: 1rem;
		padding-bottom: 0.75rem;
		border-bottom: 1px solid var(--color-border);
	}

	.results-header-copy { display: flex; flex-direction: column; gap: 0.25rem; }
	.results-eyebrow {
		margin: 0;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--color-secondary);
	}
	.results-count { display: flex; align-items: baseline; gap: 0.5rem; }
	.count-number {
		font-size: 1.875rem;
		font-weight: 600;
		color: var(--color-ink);
		font-family: var(--font-display);
		line-height: 1;
	}
	.count-label { font-size: 0.8125rem; color: var(--color-ink-muted); }

	/* Structured Summary */
	.structured-summary {
		padding: 1rem 1.125rem;
		background: var(--color-bg);
		margin-bottom: 1.5rem;
		border: 1px solid var(--color-border);
	}

	.summary-eyebrow {
		margin: 0 0 0.25rem;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--color-ink-muted);
	}
	.summary-title {
		font-size: 1.125rem;
		font-weight: 600;
		color: var(--color-ink);
		margin: 0 0 0.875rem 0;
		font-family: var(--font-display);
		letter-spacing: -0.01em;
	}
	.summary-stack { display: flex; flex-direction: column; gap: 0.75rem; }
	.summary-section {
		padding-top: 0.75rem;
		border-top: 1px solid var(--color-border);
	}
	.summary-section:first-child {
		padding-top: 0;
		border-top: none;
	}
	.summary-header { margin-bottom: 0.375rem; }

	.summary-label {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 0.6875rem;
		font-family: var(--font-mono);
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--color-secondary);
	}

	.summary-text { font-size: 0.9375rem; line-height: 1.65; color: var(--color-ink); margin: 0; }
	.summary-text :global(ul) { margin: 0; padding-left: 1.25rem; list-style-type: disc; }
	.summary-text :global(li) { margin-bottom: 0.5rem; }
	.summary-text :global(li:last-child) { margin-bottom: 0; }
	.summary-text :global(a) { color: var(--color-primary); text-decoration: none; display: inline-flex; align-items: center; }
	.summary-text :global(a:hover) { opacity: 0.8; }
	.summary-text :global(a svg) { transition: transform 0.15s ease; }
	.summary-text :global(a:hover svg) { transform: translate(1px, -1px); }
	.summary-text :global(p) { margin: 0 0 0.5rem 0; }
	.summary-text :global(p:last-child) { margin-bottom: 0; }

	/* Category Sections */
	.category-section { margin-bottom: 1.5rem; }
	.category-section:last-child { margin-bottom: 0; }

	.category-header {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		margin-bottom: 1rem;
		padding-bottom: 0.5rem;
		border-bottom: 1px solid var(--color-border);
	}

	.category-header :global(.category-icon) { color: var(--color-primary); margin-top: 0.125rem; }
	.category-heading { display: flex; flex-direction: column; gap: 0.125rem; flex: 1; min-width: 0; }
	.category-eyebrow {
		margin: 0;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--color-secondary);
	}
	.category-title {
		font-size: 1rem;
		font-weight: 600;
		color: var(--color-ink);
		margin: 0;
		font-family: var(--font-display);
		line-height: 1.2;
		letter-spacing: -0.01em;
	}
	.category-count {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 1.5rem;
		padding: 0.125rem 0.375rem;
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-pill);
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		color: var(--color-ink-muted);
		font-weight: 500;
	}
	.section-divider { border: none; border-top: 2px solid var(--color-border); margin: 1.5rem 0; }
	.results-meta {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--color-ink-muted);
	}

	.articles-grid { display: grid; grid-template-columns: 1fr; gap: 0.75rem; }

	@media (min-width: 768px) {
		.articles-grid { grid-template-columns: repeat(2, 1fr); }
	}

	/* Queries Info */
	.queries-info {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		margin-top: 1.5rem;
		padding-top: 1rem;
		border-top: 1px solid var(--color-border);
	}

	.queries-label {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--color-ink-muted);
	}
	.queries-list { display: flex; flex-wrap: wrap; gap: 0.375rem; }
	.query-tag {
		padding: 0.25rem 0.5rem;
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-pill);
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		color: var(--color-ink-muted);
	}
</style>

<script lang="ts">
	import { slide } from 'svelte/transition';
	import { webhookClient } from '$lib/services/webhook-client';
	import ProgressIndicator from '$lib/components/ui/ProgressIndicator.svelte';
	import FormPanel from '$lib/components/ui/FormPanel.svelte';
	import CriteriaInput from '$lib/components/ui/CriteriaInput.svelte';
	import StepButtons from '$lib/components/ui/StepButtons.svelte';
	import TogglePicker from '$lib/components/ui/TogglePicker.svelte';
	import ScoutScheduleModal from '$lib/components/modals/ScoutScheduleModal.svelte';
	import * as m from '$lib/paraglide/messages';

	export let onScheduled: (detail: { scoutType: 'web' }) => void = () => {};

	// Test state
	let url = '';
	let scoutName = '';
	let criteria = '';
	let criteriaMode: 'any' | 'specific' = 'specific';
	let isTestingScraper = false;
	let testError = '';
	let testResult: { summary: string; criteriaMet: boolean } | null = null;
	let testProgress = 0;
	let testProgressMessage = '';
	let testProgressTimer: ReturnType<typeof setInterval> | null = null;

	// Schedule modal state
	let showScheduleModal = false;

	// Provider detected during test
	let detectedProvider: string | undefined;
	let contentHash: string | undefined;

	// Computed progress state for ProgressIndicator
	$: progressState = (testResult ? 'success' : testError ? 'error' : 'loading') as 'loading' | 'success' | 'error';
	$: effectiveCriteria = criteriaMode === 'any' ? '' : criteria;

	async function handleTestScraper() {
		testError = '';
		testResult = null;
		isTestingScraper = true;
		testProgress = 5;
		testProgressMessage = 'Starting scraper test...';

		if (testProgressTimer) {
			clearInterval(testProgressTimer);
			testProgressTimer = null;
		}

		testProgressTimer = setInterval(() => {
			if (testProgress < 85) {
				testProgress += Math.round(Math.random() * 8 + 2);
				if (testProgress < 25) {
					testProgressMessage = 'Connecting to website...';
				} else if (testProgress < 50) {
					testProgressMessage = 'Fetching page content...';
				} else if (testProgress < 75) {
					testProgressMessage = 'Extracting data...';
				} else {
					testProgressMessage = 'Processing response...';
				}
			}
		}, 800);

		try {
			const response = await webhookClient.testScraper({ url, criteria: effectiveCriteria || undefined, scraperName: scoutName.trim() });

			if (!response.scraper_status) {
				testError = response.summary || 'This website appears to block automated access.';
				testProgress = 100;
				testProgressMessage = '';
				return;
			}

			testProgressMessage = 'Checking criteria...';
			detectedProvider = response.provider;
			contentHash = response.content_hash;
			testResult = {
				summary: response.summary,
				criteriaMet: response.criteria_status
			};
			testProgress = 100;
			testProgressMessage = 'Scraper tested successfully';
		} catch (err: unknown) {
			testError = err instanceof Error ? err.message : 'Unable to connect. Please check the URL.';
			testProgress = 100;
		} finally {
			isTestingScraper = false;
			if (testProgressTimer) {
				clearInterval(testProgressTimer);
				testProgressTimer = null;
			}
		}
	}

	function normalizeUrl() {
		const trimmed = url.trim();
		if (trimmed && !/^https?:\/\//i.test(trimmed)) {
			url = `https://${trimmed}`;
		}
	}

	function handleReset() {
		testError = '';
		testResult = null;
		testProgress = 0;
		testProgressMessage = '';
	}
</script>

<div class="panel-view">
	<div class="two-column-layout">
		<!-- Left Column: Form -->
		<div class="query-column">
			<FormPanel
				badge={m.modal_pageScoutBadge()}
				badgeVariant="blue"
				title={m.webScout_title()}
				subtitle={m.webScout_scraperTestHint()}
			>
				<!-- Scout Name Input -->
				<div class="field-group">
					<label for="scout-name" class="field-label">{m.webScout_scoutName()}</label>
					<input
						id="scout-name"
						type="text"
						bind:value={scoutName}
						maxlength="30"
						placeholder={m.webScout_scoutNamePlaceholder()}
						required
						class="form-input"
					/>
					<p class="text-xs text-gray-500 mt-1">{m.webScout_scoutNameHint()}</p>
				</div>

				<!-- URL Input -->
				<div class="field-group">
					<label for="url" class="field-label">{m.webScout_websiteUrl()}</label>
					<input
						id="url"
						type="url"
						bind:value={url}
						on:blur={normalizeUrl}
						placeholder={m.webScout_urlPlaceholder()}
						required
						class="form-input"
					/>
				</div>

				<!-- Criteria Mode Cards -->
				<div class="field-group">
					<p class="field-label">
						{m.webScout_notifyWhen()}
					</p>
					<TogglePicker
						bind:value={criteriaMode}
						options={[
							{ value: 'specific', label: m.webScout_specificCriteria(), description: m.webScout_specificCriteriaHint() },
							{ value: 'any', label: m.webScout_anyChange(), description: m.webScout_anyChangeHint() }
						]}
					/>

					{#if criteriaMode === 'specific'}
						<div class="criteria-detail" transition:slide={{ duration: 200 }}>
							<CriteriaInput
								bind:value={criteria}
								placeholder={m.webScout_criteriaPlaceholder()}
								rows={3}
								examples={[
									{ label: m.webScout_criteriaExample1(), value: 'New job postings' },
									{ label: m.webScout_criteriaExample2(), value: 'Price changes' },
									{ label: m.webScout_criteriaExample3(), value: 'New events listed' },
								]}
							/>
						</div>
					{/if}
				</div>

				<!-- Step Buttons -->
				{#if !testError}
					<StepButtons
						step1Disabled={isTestingScraper || !url.trim() || !scoutName.trim() || (criteriaMode === 'specific' && !criteria.trim())}
						step1Loading={isTestingScraper}
						step1Label={m.webScout_runScraper()}
						step1LoadingLabel={m.common_testing()}
						step2Enabled={!!testResult}
						onStep1={handleTestScraper}
						onStep2={() => showScheduleModal = true}
					/>
				{:else}
					<button
						on:click={handleReset}
						class="btn-secondary w-full"
					>
						{m.common_tryAgain()}
					</button>
				{/if}
			</FormPanel>
		</div>

		<!-- Right Column: Results -->
		<div class="results-column">
			{#if isTestingScraper || testProgress > 0 || testResult || testError}
				<ProgressIndicator
					progress={testProgress}
					message={testProgressMessage}
					state={progressState}
					successMessage={m.webScout_scraperTestSuccess()}
					successDetails={testResult?.summary || ''}
					errorTitle={m.webScout_errorBlocked()}
					errorMessage={testError}
					showButton={false}
					hintText={isTestingScraper ? m.webScout_scraperTestRunning() : ''}
					compact={!!testResult}
				/>
			{/if}
		</div>
	</div>
</div>

<!-- Schedule Modal -->
<ScoutScheduleModal
	bind:open={showScheduleModal}
	scoutType="web"
	url={url}
	webCriteria={effectiveCriteria}
	provider={detectedProvider}
	scoutName={scoutName.trim()}
	contentHash={contentHash}
	onClose={() => showScheduleModal = false}
	onSuccess={() => {
		url = '';
		criteria = '';
		criteriaMode = 'specific';
		scoutName = '';
		testResult = null;
		testProgress = 0;
		detectedProvider = undefined;
		contentHash = undefined;
		showScheduleModal = false;
		onScheduled({ scoutType: 'web' });
	}}
/>

<style>
	.field-group { margin-bottom: 1rem; }

	.field-label {
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--color-ink);
		margin: 0 0 0.5rem 0;
	}


	.criteria-detail { margin-top: 0.75rem; }
</style>

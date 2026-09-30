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

	let contentHash: string | undefined;
	let testedInputKey = '';

	// Computed progress state for ProgressIndicator
	$: progressState = (testResult ? 'success' : testError ? 'error' : 'loading') as 'loading' | 'success' | 'error';
	$: effectiveCriteria = criteriaMode === 'any' ? '' : criteria;
	$: canTest = !!url.trim() && (criteriaMode === 'any' || !!criteria.trim());
	$: inputKey = JSON.stringify([url.trim(), effectiveCriteria.trim()]);
	$: if ((testResult || testError) && testedInputKey !== inputKey) handleReset();

	async function handleTestScraper() {
		if (!canTest) return;
		const requestedInputKey = inputKey;
		testedInputKey = requestedInputKey;
		contentHash = undefined;
		testError = '';
		testResult = null;
		isTestingScraper = true;
		testProgress = 5;
		testProgressMessage = m.pageScout_startingTest();

		if (testProgressTimer) {
			clearInterval(testProgressTimer);
			testProgressTimer = null;
		}

		testProgressTimer = setInterval(() => {
			if (testProgress < 85) {
				testProgress += Math.round(Math.random() * 8 + 2);
				if (testProgress < 25) {
					testProgressMessage = m.pageScout_connecting();
				} else if (testProgress < 50) {
					testProgressMessage = m.pageScout_fetching();
				} else if (testProgress < 75) {
					testProgressMessage = m.scrape_extracting();
				} else {
					testProgressMessage = m.pageScout_processing();
				}
			}
		}, 800);

		try {
			const response = await webhookClient.testScraper({ url, criteria: effectiveCriteria || undefined });
			if (inputKey !== requestedInputKey) return;

			if (!response.scraper_status) {
				// The probe envelope's `error` is the server's human sentence for
				// `error_code` (unreachable / blocked / empty_content). The
				// hardcoded text is only a fallback for a pre-envelope server.
				testError = response.error || response.summary || m.pageScout_blocked();
				testProgress = 100;
				testProgressMessage = '';
				return;
			}

			testProgressMessage = m.pageScout_checkingCriteria();
			contentHash = response.content_hash;
			testResult = {
				summary: response.summary,
				criteriaMet: response.criteria_status
			};
			testProgress = 100;
			testProgressMessage = m.webScout_scraperTestSuccess();
		} catch (err: unknown) {
			if (inputKey !== requestedInputKey) return;
			testError = err instanceof Error ? err.message : m.pageScout_connectionFailed();
			testProgress = 100;
		} finally {
			if (inputKey !== requestedInputKey) handleReset();
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
		contentHash = undefined;
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
				<!-- URL Input -->
				<div class="field-group">
					<label for="url" class="field-label">{m.webScout_websiteUrl()} <span aria-hidden="true">*</span></label>
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
							<label for="page-criteria" class="field-label">{m.beatScout_criteriaLabel()} <span aria-hidden="true">*</span></label>
							<CriteriaInput
								inputId="page-criteria"
								required
								bind:value={criteria}
								placeholder={m.webScout_criteriaPlaceholder()}
								rows={3}
								examples={[
									{ label: m.webScout_criteriaExample1(), value: m.webScout_criteriaExample1() },
									{ label: m.webScout_criteriaExample2(), value: m.webScout_criteriaExample2() },
									{ label: m.webScout_criteriaExample3(), value: m.webScout_criteriaExample3() },
								]}
							/>
						</div>
					{:else}
						<p class="any-change-warning" role="note">
							{m.webScout_anyChangeWarning()}
						</p>
					{/if}
				</div>

				<!-- Step Buttons -->
				{#if !testError}
					<StepButtons
						step1Disabled={isTestingScraper || !canTest}
						step1Loading={isTestingScraper}
						step1Label={m.webScout_runScraper()}
						step1LoadingLabel={m.common_testing()}
						step2Enabled={!!testResult && canTest && testedInputKey === inputKey}
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
	contentHash={contentHash}
	onClose={() => showScheduleModal = false}
	onSuccess={() => {
		url = '';
		criteria = '';
		criteriaMode = 'specific';
		handleReset();
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
	.any-change-warning {
		margin: 0.75rem 0 0;
		padding: 0.75rem;
		border: 1px solid color-mix(in oklab, var(--color-warning) 34%, var(--color-border));
		background: color-mix(in oklab, var(--color-warning) 10%, var(--color-card));
		color: var(--color-ink-muted);
		font-size: 0.75rem;
		line-height: 1.45;
	}
</style>

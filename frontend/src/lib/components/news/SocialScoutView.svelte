<script lang="ts">
	import { slide } from 'svelte/transition';
	import ProgressIndicator from '$lib/components/ui/ProgressIndicator.svelte';
	import FormPanel from '$lib/components/ui/FormPanel.svelte';
	import StepButtons from '$lib/components/ui/StepButtons.svelte';
	import TogglePicker from '$lib/components/ui/TogglePicker.svelte';
	import ScoutScheduleModal from '$lib/components/modals/ScoutScheduleModal.svelte';
	import * as m from '$lib/paraglide/messages';
	import { buildApiUrl } from '$lib/config/api';

	export let onScheduled: (detail: { scoutType: 'social' }) => void = () => {};

	// Form state
	let platform: 'instagram' | 'x' | 'facebook' | 'tiktok' | 'linkedin' = 'instagram';
	let handle = '';
	let monitorMode: 'summarize' | 'criteria' = 'summarize';
	let criteria = '';
	let trackRemovals = false;

	// Test state
	let isVerifying = false;
	let verifyError = '';
	let verifySuccess = false;
	let testProgress = 0;
	let testProgressMessage = '';
	let testProgressTimer: ReturnType<typeof setInterval> | null = null;

	// Baseline state from scan
	let baselinePosts: Record<string, unknown>[] = [];
	let baselinePostIds: string[] = [];
	let previewPosts: { id: string; text: string; timestamp: string }[] = [];
	let scanWarning = '';

	// Schedule modal state
	let showScheduleModal = false;

	// Computed progress state for ProgressIndicator
	$: progressState = (verifySuccess ? 'success' : verifyError ? 'error' : 'loading') as 'loading' | 'success' | 'error';

	// Normalize handle: strip leading @
	$: normalizedHandle = handle.replace(/^@/, '').trim();
	$: canVerify = normalizedHandle.length > 0;

	async function handleVerifyProfile() {
		verifyError = '';
		verifySuccess = false;
		scanWarning = '';
		baselinePosts = [];
		baselinePostIds = [];
		previewPosts = [];
		isVerifying = true;
		testProgress = 5;
		testProgressMessage = 'Connecting to platform...';

		if (testProgressTimer) {
			clearInterval(testProgressTimer);
			testProgressTimer = null;
		}

		testProgressTimer = setInterval(() => {
			if (testProgress < 85) {
				testProgress += Math.round(Math.random() * 5 + 2);
				if (testProgress < 20) {
					testProgressMessage = 'Connecting to platform...';
				} else if (testProgress < 40) {
					testProgressMessage = 'Looking up profile...';
				} else if (testProgress < 65) {
					testProgressMessage = 'Scanning recent posts...';
				} else {
					testProgressMessage = 'Building baseline...';
				}
			}
		}, 800);

		try {
			const { authStore } = await import('$lib/stores/auth');
			const token = await authStore.getToken();
			const response = await fetch(buildApiUrl('/social-test'), {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(token ? { Authorization: `Bearer ${token}` } : {})
				},
				body: JSON.stringify({ platform, handle: normalizedHandle })
			});

			if (!response.ok) {
				const errorData = await response.json().catch(() => ({}));
				verifyError = (errorData as { detail?: string }).detail || m.socialScout_verifyFailed();
				testProgress = 100;
				testProgressMessage = '';
				return;
			}

			const data = await response.json() as {
				valid: boolean;
				profile_url: string;
				error?: string;
				post_ids: string[];
				preview_posts: { id: string; text: string; timestamp: string }[];
				posts_data: Record<string, unknown>[];
			};

			if (!data.valid) {
				verifyError = data.error || m.socialScout_verifyFailed();
				testProgress = 100;
				testProgressMessage = '';
				return;
			}

			// Store baseline data
			baselinePostIds = data.post_ids || [];
			previewPosts = data.preview_posts || [];
			baselinePosts = data.posts_data || [];

			// Check for partial success (HEAD ok but Apify failed)
			if (data.error && data.post_ids.length === 0) {
				scanWarning = m.socialScout_scanWarning();
			}

			verifySuccess = true;
			testProgress = 100;
			testProgressMessage = m.socialScout_verifySuccess({ count: String(baselinePostIds.length) });
		} catch {
			verifyError = m.socialScout_verifyFailed();
			testProgress = 100;
		} finally {
			isVerifying = false;
			if (testProgressTimer) {
				clearInterval(testProgressTimer);
				testProgressTimer = null;
			}
		}
	}

	function handleReset() {
		verifyError = '';
		verifySuccess = false;
		scanWarning = '';
		baselinePosts = [];
		baselinePostIds = [];
		previewPosts = [];
		testProgress = 0;
		testProgressMessage = '';
	}
</script>

<div class="panel-view">
	<div class="two-column-layout">
		<!-- Left Column: Form -->
		<div class="query-column">
			<FormPanel
				badge={m.socialScout_badge()}
				badgeVariant="purple"
				title={m.socialScout_title()}
				subtitle={m.socialScout_subtitle()}
			>
				<!-- Platform Picker -->
				<div class="field-group">
					<label for="social-platform" class="field-label">{m.socialScout_platformLabel()}</label>
					<select
						id="social-platform"
						bind:value={platform}
						class="form-input w-full text-sm"
					>
						<option value="instagram">Instagram</option>
						<option value="x">X</option>
						<option value="facebook">Facebook Profile</option>
						<option value="tiktok">TikTok</option>
						<option value="linkedin">LinkedIn Profile</option>
					</select>
				</div>

				<!-- Handle Input -->
				<div class="field-group">
					<label for="social-handle" class="field-label">{m.socialScout_handleLabel()}</label>
					<input
						id="social-handle"
						type="text"
						bind:value={handle}
						placeholder={m.socialScout_handlePlaceholder()}
						class="form-input"
					/>
				</div>

				<!-- Monitor Mode Picker -->
				<div class="field-group">
					<div class="field-label">{m.socialScout_modeLabel()}</div>
					<TogglePicker
						bind:value={monitorMode}
						options={[
							{ value: 'summarize', label: m.socialScout_modeSummarize(), description: m.socialScout_modeSummarizeDesc() },
							{ value: 'criteria', label: m.socialScout_modeCriteria(), description: m.socialScout_modeCriteriaDesc() }
						]}
					/>

					{#if monitorMode === 'criteria'}
						<div class="criteria-detail" transition:slide={{ duration: 200 }}>
							<label for="social-criteria" class="field-label">{m.socialScout_criteriaLabel()}</label>
							<textarea
								id="social-criteria"
								bind:value={criteria}
								rows="3"
								placeholder={m.webScout_criteriaPlaceholder()}
								class="form-textarea"
							></textarea>
						</div>
					{/if}
				</div>

				<!-- Track Removals Checkbox -->
				<div class="field-group">
					<label class="checkbox-row">
						<input type="checkbox" bind:checked={trackRemovals} class="form-checkbox" />
						<span class="checkbox-content">
							<span class="checkbox-label">{m.socialScout_trackRemovals()}</span>
							<span class="checkbox-desc">{m.socialScout_trackRemovalsDesc()}</span>
						</span>
					</label>
				</div>

				<!-- Step Buttons -->
				{#if !verifyError}
					<StepButtons
						step1Disabled={isVerifying || !canVerify}
						step1Loading={isVerifying}
						step1Label={m.socialScout_verifyButton()}
						step1LoadingLabel={m.common_testing()}
						step2Enabled={verifySuccess}
						onStep1={handleVerifyProfile}
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
			{#if isVerifying || testProgress > 0 || verifySuccess || verifyError}
				<ProgressIndicator
					progress={testProgress}
					message={testProgressMessage}
					state={progressState}
					successMessage={m.socialScout_verifySuccess({ count: String(baselinePostIds.length) })}
					successDetails={'@' + normalizedHandle + ' on ' + platform}
					errorTitle={m.socialScout_verifyFailed()}
					errorMessage={verifyError}
					showButton={false}
					hintText={isVerifying ? m.common_testing() : ''}
				/>

				{#if verifySuccess && previewPosts.length > 0}
					<div class="baseline-preview">
						{#if scanWarning}
							<p class="scan-warning">{scanWarning}</p>
						{/if}
						<p class="preview-label">Recent posts (baseline)</p>
						{#each previewPosts as post}
							<div class="preview-post">
								<span class="preview-text">{post.text || '(no caption)'}</span>
								{#if post.timestamp}
									<span class="preview-ts">{post.timestamp}</span>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			{/if}
		</div>
	</div>
</div>

<!-- Schedule Modal -->
<ScoutScheduleModal
	bind:open={showScheduleModal}
	scoutType="social"
	profile_handle={normalizedHandle}
	{platform}
	monitor_mode={monitorMode}
	criteria={monitorMode === 'criteria' ? criteria : ''}
	{trackRemovals}
	scoutName=""
	baselinePosts={baselinePosts}
	onClose={() => showScheduleModal = false}
	onSuccess={() => {
		handle = '';
		criteria = '';
		monitorMode = 'summarize';
		trackRemovals = false;
		verifySuccess = false;
		testProgress = 0;
		baselinePosts = [];
		baselinePostIds = [];
		previewPosts = [];
		scanWarning = '';
		showScheduleModal = false;
		onScheduled({ scoutType: 'social' });
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

	.checkbox-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		cursor: pointer;
	}

	.form-checkbox {
		width: 0.875rem;
		height: 0.875rem;
		accent-color: var(--color-accent, var(--color-primary));
		flex-shrink: 0;
	}

	.checkbox-content {
		display: flex;
		align-items: baseline;
		gap: 0.375rem;
	}

	.checkbox-label {
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--color-ink);
	}

	.checkbox-desc {
		font-size: 0.75rem;
		color: var(--color-text-tertiary, #9ca3af);
	}

	.baseline-preview {
		margin-top: 1rem;
		padding: 0.75rem;
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: 0;
	}

	.preview-label {
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--color-ink-muted);
		text-transform: uppercase;
		margin: 0 0 0.5rem 0;
	}

	.preview-post {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		padding: 0.375rem 0;
		border-bottom: 1px solid var(--color-border);
	}

	.preview-post:last-child {
		border-bottom: none;
	}

	.preview-text {
		font-size: 0.8125rem;
		color: var(--color-ink);
		line-height: 1.3;
	}

	.preview-ts {
		font-size: 0.6875rem;
		color: var(--color-ink-subtle);
	}

	.scan-warning {
		font-size: 0.75rem;
		color: #9F6016;
		margin: 0 0 0.5rem 0;
		padding: 0.375rem 0.5rem;
		background: #fffbeb;
		border-radius: 0;
	}
</style>

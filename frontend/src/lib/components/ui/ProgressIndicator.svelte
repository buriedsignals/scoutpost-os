<script lang="ts">
	import { CheckCircle, Clock, XCircle } from 'lucide-svelte';
	import { fade, slide } from 'svelte/transition';
	import * as m from '$lib/paraglide/messages';

	export let progress = 0;
	export let message = 'Loading...';
	export let state: 'loading' | 'success' | 'error' = 'loading';
	export let successMessage = 'Complete!';
	export let successDetails = '';
	export let errorTitle = '';
	export let errorMessage = '';
	export let showButton = false;
	export let buttonText = 'Continue';
	export let hintText = 'This may take a moment';
	export let onAction: () => void = () => {};
	export let compact = false;

	function handleAction() {
		onAction();
	}
</script>

<div
	class="extraction-progress"
	class:extraction-progress--success={state === 'success'}
	class:extraction-progress--error={state === 'error'}
	class:extraction-progress--compact={compact}
>
	{#if state === 'loading'}
		<!-- Loading State -->
		{#if hintText}
			<div class="extraction-progress__footer">
				<p class="extraction-progress__hint">
					<Clock class="extraction-progress__icon" />
					{hintText}
				</p>
			</div>
		{/if}
		<div class="extraction-progress__header">
			<span class="extraction-progress__message">{message}</span>
			<span class="extraction-progress__percentage">{progress}%</span>
		</div>
		<div class="extraction-progress__track">
			<div class="extraction-progress__fill" style="width: {progress}%"></div>
			<div class="extraction-progress__shimmer" style="width: {progress}%"></div>
		</div>

	{:else if state === 'success'}
		<!-- Success State -->
		<div class="extraction-progress__success" transition:fade={{ duration: 300 }}>
			<div class="extraction-progress__success-header">
				<div class="extraction-progress__success-icon">
					<CheckCircle class="h-6 w-6" />
				</div>
				<div class="extraction-progress__success-text">
					<span class="extraction-progress__success-title">{successMessage}</span>
					{#if successDetails}
						<span class="extraction-progress__success-details">{successDetails}</span>
					{/if}
				</div>
			</div>

			{#if showButton}
				<button
					class="btn-primary w-full mt-3"
					on:click={handleAction}
					transition:slide={{ duration: 200 }}
				>
					{buttonText}
				</button>
			{/if}
		</div>

	{:else if state === 'error'}
		<!-- Error State -->
		<div class="extraction-progress__error" transition:fade={{ duration: 300 }}>
			<div class="extraction-progress__error-header">
				<div class="extraction-progress__error-icon">
					<XCircle class="h-6 w-6" />
				</div>
				<div class="extraction-progress__error-text">
					<span class="extraction-progress__error-title">{errorTitle || m.progress_error()}</span>
					{#if errorMessage}
						<span class="extraction-progress__error-details">{errorMessage}</span>
					{/if}
				</div>
			</div>

			<!-- Failed progress bar (red) -->
			<div class="extraction-progress__track extraction-progress__track--error">
				<div class="extraction-progress__fill extraction-progress__fill--error" style="width: {progress}%"></div>
			</div>

			{#if showButton}
				<button
					class="btn-secondary w-full mt-3"
					on:click={handleAction}
					transition:slide={{ duration: 200 }}
				>
					{buttonText}
				</button>
			{/if}
		</div>
	{/if}
</div>

<style>
	.extraction-progress--compact {
		padding: 0.875rem 1rem;
		background: color-mix(in oklab, var(--color-surface-alt) 72%, transparent);
		border-color: color-mix(in oklab, var(--color-border) 72%, transparent);
		opacity: 0.82;
	}

	.extraction-progress--compact::before { display: none; }
	.extraction-progress--compact .extraction-progress__success-icon :global(svg) {
		width: 1.125rem;
		height: 1.125rem;
	}

	/* Success state modifiers */
	.extraction-progress--success {
		background: color-mix(in oklab, var(--color-success) 9%, var(--color-card));
		border-color: color-mix(in oklab, var(--color-success) 30%, var(--color-border));
	}

	.extraction-progress--success::before {
		background: var(--color-success);
	}

	.extraction-progress__success {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.extraction-progress__success-header {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
	}

	.extraction-progress__success-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		color: var(--color-success);
	}

	.extraction-progress__success-text {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.extraction-progress__success-title {
		font-family: var(--font-body);
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--color-success);
	}

	.extraction-progress__success-details {
		font-size: 0.8125rem;
		color: var(--color-muted-foreground);
	}

	/* Error state modifiers */
	.extraction-progress--error {
		background: color-mix(in oklab, var(--color-error) 9%, var(--color-card));
		border-color: color-mix(in oklab, var(--color-error) 30%, var(--color-border));
	}

	.extraction-progress--error::before {
		background: var(--color-error);
	}

	.extraction-progress__error {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.extraction-progress__error-header {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
	}

	.extraction-progress__error-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		color: var(--color-error);
	}

	.extraction-progress__error-text {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.extraction-progress__error-title {
		font-family: var(--font-body);
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--color-error);
	}

	.extraction-progress__error-details {
		font-size: 0.8125rem;
		color: var(--color-error);
	}

	.extraction-progress__track--error {
		background: color-mix(in oklab, var(--color-error) 12%, transparent);
	}

	.extraction-progress__fill--error {
		background: var(--color-error);
	}
</style>

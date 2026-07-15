<script lang="ts">
	import * as m from '$lib/paraglide/messages';

	export let open = false;
	export let onReady: () => void = () => {};

	let dialogEl: HTMLDivElement;
	let videoLoaded = false;

	function handleReady() {
		onReady();
	}

	function handleSkip() {
		// Allow users to skip if they can't watch the video
		onReady();
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			// Allow escape to skip the video
			handleSkip();
		}
	}

	function handleVideoLoad() {
		videoLoaded = true;
	}

	// Focus the modal when it opens
	$: if (open && dialogEl) {
		dialogEl.focus();
	}
</script>

{#if open}
	<!-- Modal backdrop -->
	<div
		bind:this={dialogEl}
		class="modal-backdrop"
		role="dialog"
		aria-modal="true"
		aria-label="Introduction video"
		tabindex="-1"
		on:keydown={handleKeydown}
	>
		<!-- Modal content -->
		<div class="modal-container">
			<!-- Video embed (16:9 aspect ratio) -->
			<div class="video-wrapper">
				{#if !videoLoaded}
					<div class="video-loading">
						<div class="loading-spinner"></div>
						<span>Loading video...</span>
					</div>
				{/if}
				<iframe
					src="https://www.loom.com/embed/13aa8f755b9345b4ae3b30eea0a12053?hide_owner=true&hide_share=true&hide_title=true&hideEmbedTopBar=true"
					frameborder="0"
					allow="fullscreen"
					allowfullscreen
					title="Scoutpost Introduction"
					class:loaded={videoLoaded}
					on:load={handleVideoLoad}
				></iframe>
			</div>

			<!-- Footer with buttons -->
			<div class="modal-footer">
				<button
					on:click={handleReady}
					class="ready-btn"
				>
					{m.tour_videoReady()}
				</button>
				<button
					on:click={handleSkip}
					class="skip-btn"
					aria-label="Skip video and continue"
				>
					{m.tour_skip()}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.modal-backdrop {
		position: fixed;
		inset: 0;
		background: var(--modal-backdrop);
		backdrop-filter: blur(8px);
		z-index: 50;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1rem;
		animation: fadeIn 0.2s ease-out;
	}

	@media (prefers-reduced-motion: reduce) {
		.modal-backdrop {
			animation: none;
		}
	}

	@keyframes fadeIn {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}

	.modal-container {
		background: var(--color-surface-alt);
		border-radius: var(--radius-md);
		box-shadow: 0 20px 60px rgba(0, 0, 0, 0.2), 0 0 1px rgba(0, 0, 0, 0.1);
		max-width: 800px;
		width: 100%;
		overflow: hidden;
		display: flex;
		flex-direction: column;
		animation: slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1);
	}

	@media (prefers-reduced-motion: reduce) {
		.modal-container {
			animation: none;
		}
	}

	@keyframes slideUp {
		from {
			opacity: 0;
			transform: translateY(20px) scale(0.98);
		}
		to {
			opacity: 1;
			transform: translateY(0) scale(1);
		}
	}

	.video-wrapper {
		position: relative;
		width: 100%;
		padding-bottom: 56.25%; /* 16:9 aspect ratio */
		background: var(--color-ink);
	}

	.video-loading {
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 1rem;
		color: var(--color-ink-subtle);
		font-size: 0.875rem;
	}

	.loading-spinner {
		width: 32px;
		height: 32px;
		border: 3px solid color-mix(in oklab, var(--color-primary) 30%, transparent);
		border-top-color: var(--color-primary);
		border-radius: 50%;
		animation: spin 1s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	.video-wrapper iframe {
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		opacity: 0;
		transition: opacity 0.3s ease;
	}

	.video-wrapper iframe.loaded {
		opacity: 1;
	}

	.modal-footer {
		padding: 1.25rem 1.5rem;
		background: var(--color-bg);
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.ready-btn {
		width: 100%;
		padding: 0.875rem 1.5rem;
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--primary-foreground);
		background: var(--color-primary);
		border: none;
		border-radius: var(--radius-md);
		cursor: pointer;
		transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
		font-family: var(--font-body);
		box-shadow: 0 10px 24px -14px color-mix(in oklab, var(--color-primary) 62%, transparent);
	}

	.ready-btn:hover {
		background: color-mix(in oklab, var(--color-primary) 88%, white);
		transform: translateY(-1px);
		box-shadow: 0 14px 28px -16px color-mix(in oklab, var(--color-primary) 72%, transparent);
	}

	.ready-btn:active {
		transform: translateY(0);
		box-shadow: var(--shadow-sm);
	}

	.skip-btn {
		width: 100%;
		padding: 0.5rem 1rem;
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--color-ink-subtle);
		background: transparent;
		border: none;
		cursor: pointer;
		transition: color 0.2s ease;
		font-family: var(--font-body);
	}

	.skip-btn:hover {
		color: var(--color-ink-muted);
	}

	/* Responsive */
	@media (max-width: 640px) {
		.modal-container {
			max-width: 100%;
			margin: 0.5rem;
		}
	}
</style>

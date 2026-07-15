<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import * as m from '$lib/paraglide/messages';

	export let targetSelector: string;
	export let title: string;
	export let text: string;
	export let currentStep: number;
	export let totalSteps: number;
	export let isLastStep = false;
	export let onNext: () => void = () => {};
	export let onDone: () => void = () => {};

	let tooltipEl: HTMLDivElement;
	let position = { top: 0, left: 0 };
	let placement: 'right' | 'below' = 'right';
	let retryCount = 0;
	const MAX_RETRIES = 10;
	const RETRY_DELAY = 100;
	const TOOLTIP_WIDTH = 320;

	function calculatePosition() {
		if (typeof document === 'undefined') return;

		const target = document.querySelector(targetSelector);
		if (!target) {
			if (retryCount < MAX_RETRIES) {
				retryCount++;
				setTimeout(calculatePosition, RETRY_DELAY);
			}
			return;
		}

		retryCount = 0;
		const rect = target.getBoundingClientRect();
		const vw = window.innerWidth;

		if (rect.right + 16 + TOOLTIP_WIDTH > vw) {
			// Not enough room to the right — place below, aligned to right edge
			placement = 'below';
			position = {
				top: rect.bottom + 12,
				left: Math.min(rect.right, vw - 16) - TOOLTIP_WIDTH
			};
		} else {
			placement = 'right';
			position = {
				top: rect.top + rect.height / 2,
				left: rect.right + 16
			};
		}
	}

	function handleClick() {
		if (isLastStep) {
			onDone();
		} else {
			onNext();
		}
	}

	onMount(() => {
		calculatePosition();
		window.addEventListener('resize', calculatePosition);
	});

	onDestroy(() => {
		if (typeof window !== 'undefined') {
			window.removeEventListener('resize', calculatePosition);
		}
	});
</script>

<div
	bind:this={tooltipEl}
	class="tooltip"
	class:below={placement === 'below'}
	style="top: {position.top}px; left: {position.left}px;"
	role="tooltip"
	aria-live="polite"
>
	<div class="arrow"></div>

	<div class="tooltip-content">
		<div class="tooltip-header">
			<h3 class="tooltip-title">{title}</h3>
			<span class="step-indicator">{currentStep} of {totalSteps}</span>
		</div>
		<p class="tooltip-text">{text}</p>
		<button
			class="tooltip-btn"
			on:click={handleClick}
			aria-label={isLastStep ? 'Complete tour' : 'Go to next step'}
		>
			{isLastStep ? m.tour_done() : m.tour_next()}
		</button>
	</div>
</div>

<style>
	.tooltip {
		position: fixed;
		z-index: 60;
		transform: translateY(-50%);
		animation: fadeIn 0.2s ease-out;
	}

	.tooltip.below {
		transform: none;
		animation: fadeInBelow 0.2s ease-out;
	}

	@media (prefers-reduced-motion: reduce) {
		.tooltip {
			animation: none;
		}
	}

	@keyframes fadeIn {
		from {
			opacity: 0;
			transform: translateY(-50%) translateX(-8px);
		}
		to {
			opacity: 1;
			transform: translateY(-50%) translateX(0);
		}
	}

	@keyframes fadeInBelow {
		from {
			opacity: 0;
			transform: translateY(-8px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	.arrow {
		position: absolute;
		left: -8px;
		top: 50%;
		transform: translateY(-50%);
		width: 0;
		height: 0;
		border-top: 8px solid transparent;
		border-bottom: 8px solid transparent;
		border-right: 8px solid var(--popover);
		filter: drop-shadow(-2px 0 2px rgba(0, 0, 0, 0.1));
	}

	.tooltip.below .arrow {
		left: auto;
		right: 2rem;
		top: -8px;
		transform: none;
		border-top: none;
		border-right: 8px solid transparent;
		border-left: 8px solid transparent;
		border-bottom: 8px solid var(--popover);
		filter: drop-shadow(0 -2px 2px rgba(0, 0, 0, 0.1));
	}

	.tooltip-content {
		background: var(--popover);
		border: 1px solid var(--color-border);
		border-radius: 0.75rem;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15), 0 0 1px rgba(0, 0, 0, 0.1);
		padding: 1rem 1.25rem;
		min-width: 260px;
		max-width: 320px;
	}

	.tooltip-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 0.5rem;
	}

	.tooltip-title {
		font-size: 0.9375rem;
		font-weight: 700;
		color: var(--color-foreground);
		margin: 0;
		letter-spacing: -0.01em;
	}

	.step-indicator {
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--color-muted-foreground);
		background: var(--color-surface);
		padding: 0.25rem 0.5rem;
		border-radius: 0.25rem;
	}

	.tooltip-text {
		font-size: 0.875rem;
		line-height: 1.5;
		color: var(--color-muted-foreground);
		margin: 0 0 1rem 0;
	}

	.tooltip-btn {
		width: 100%;
		padding: 0.625rem 1rem;
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--primary-foreground);
		background: var(--color-primary);
		border: none;
		border-radius: 0.5rem;
		cursor: pointer;
		transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
		font-family: var(--font-body);
	}

	.tooltip-btn:hover {
		background: color-mix(in oklab, var(--color-primary) 88%, white);
		transform: translateY(-1px);
	}

	.tooltip-btn:active {
		transform: translateY(0);
	}
</style>

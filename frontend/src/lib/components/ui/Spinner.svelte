<script lang="ts">
	export let size: 'sm' | 'md' | 'lg' = 'md';
	export let variant: 'primary' | 'white' = 'primary';

	const sizeMap = {
		sm: '20px',
		md: '40px',
		lg: '60px'
	};
</script>

<div 
	class="spinner {size} {variant}" 
	style="
		--spinner-size: {sizeMap[size]};
		--color-1: {variant === 'white' ? 'var(--foreground)' : 'var(--color-primary)'};
		--color-2: {variant === 'white' ? 'color-mix(in oklab, var(--foreground) 80%, transparent)' : 'var(--color-moonlight)'};
		--color-3: {variant === 'white' ? 'color-mix(in oklab, var(--foreground) 30%, transparent)' : 'color-mix(in oklab, var(--color-primary) 30%, transparent)'};
	"
>
	<div class="spinner-ring ring-1"></div>
	<div class="spinner-ring ring-2"></div>
	<div class="spinner-ring ring-3"></div>
	<div class="spinner-dot"></div>
</div>

<style>
	.spinner {
		position: relative;
		width: var(--spinner-size);
		height: var(--spinner-size);
		display: inline-block;
		outline: none !important;
		box-shadow: none !important;
	}

	.spinner-ring {
		position: absolute;
		inset: 0;
		border-radius: 50%;
		border: 2px solid transparent;
		animation: spin 2s cubic-bezier(0.68, -0.55, 0.27, 1.55) infinite;
		outline: none !important;
		box-shadow: none !important;
	}

	/* Override any Tailwind ring utilities */
	.spinner,
	.spinner *,
	.spinner::before,
	.spinner::after {
		--tw-ring-offset-shadow: 0 0 #0000 !important;
		--tw-ring-shadow: 0 0 #0000 !important;
		--tw-ring-color: transparent !important;
		--tw-ring-offset-width: 0px !important;
		--tw-ring-offset-color: transparent !important;
	}

	.ring-1 {
		border-top-color: var(--color-1);
		border-right-color: var(--color-1);
		animation-duration: 1.8s;
	}

	.ring-2 {
		border-bottom-color: var(--color-2);
		border-left-color: var(--color-2);
		animation-duration: 2.2s;
		animation-delay: -0.3s;
	}

	.ring-3 {
		border-top-color: var(--color-3);
		animation-duration: 2.6s;
		animation-delay: -0.6s;
	}

	.spinner-dot {
		position: absolute;
		top: 50%;
		left: 50%;
		width: 25%;
		height: 25%;
		background: linear-gradient(135deg, var(--color-1), var(--color-2));
		border-radius: 50%;
		transform: translate(-50%, -50%);
		animation: pulse 1.5s ease-in-out infinite;
		box-shadow: 0 0 8px color-mix(in oklab, var(--color-1) 42%, transparent);
	}

	@keyframes spin {
		0% {
			transform: rotate(0deg);
		}
		100% {
			transform: rotate(360deg);
		}
	}

	@keyframes pulse {
		0%, 100% {
			opacity: 1;
			transform: translate(-50%, -50%) scale(1);
		}
		50% {
			opacity: 0.6;
			transform: translate(-50%, -50%) scale(0.85);
		}
	}
</style>

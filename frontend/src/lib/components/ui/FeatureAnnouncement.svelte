<script lang="ts">
	import { X } from 'lucide-svelte';
	import { claimAnnouncement } from '$lib/utils/feature-announcements';

	/** Stable, never-reused identifier; a new id announces a new feature. */
	export let id: string;
	/** The signed-in user; the banner waits until it is known. */
	export let userId: string | null | undefined;
	export let badge: string;
	export let title: string;
	export let body: string;
	export let ctaLabel: string;
	export let ctaHref: string;
	export let dismissLabel: string;

	let claimed = false;
	let visible = false;

	// Claim once, as soon as the user is known. Seen is recorded on display, so
	// the banner stays for this visit and is gone on the next one.
	$: if (userId && !claimed) {
		claimed = true;
		visible = claimAnnouncement(id, userId);
	}
</script>

{#if visible}
	<aside class="feature-announcement" aria-label={title}>
		<span class="feature-announcement__badge">{badge}</span>
		<p class="feature-announcement__copy">
			<strong>{title}</strong>
			<span>{body}</span>
		</p>
		<a
			class="feature-announcement__cta"
			href={ctaHref}
			target="_blank"
			rel="noopener noreferrer"
			on:click={() => (visible = false)}
		>
			{ctaLabel} <span aria-hidden="true">↗</span>
		</a>
		<button
			class="feature-announcement__dismiss"
			type="button"
			aria-label={dismissLabel}
			title={dismissLabel}
			on:click={() => (visible = false)}
		>
			<X size={16} />
		</button>
	</aside>
{/if}

<style>
	.feature-announcement {
		display: flex;
		align-items: center;
		gap: 0.875rem;
		margin: 0.75rem 1.25rem 0;
		padding: 0.75rem 0.75rem 0.75rem 1rem;
		background: oklch(0.79 0.08 78 / 12%);
		border: 1px solid oklch(0.79 0.08 78 / 45%);
		border-radius: var(--radius-lg);
		color: var(--color-ink, var(--foreground));
	}

	.feature-announcement__badge {
		flex-shrink: 0;
		padding: 0.1875rem 0.5rem;
		font-family: var(--font-mono);
		font-size: 0.625rem;
		font-weight: 600;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--primary-foreground);
		background: var(--primary);
		border-radius: var(--radius-pill, 999px);
	}

	.feature-announcement__copy {
		flex: 1;
		min-width: 0;
		margin: 0;
		font-size: 0.875rem;
		line-height: 1.45;
		color: var(--muted-foreground);
	}

	.feature-announcement__copy strong {
		margin-right: 0.375rem;
		font-weight: 600;
		color: var(--foreground);
	}

	.feature-announcement__cta {
		flex-shrink: 0;
		padding: 0.4375rem 0.875rem;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		text-decoration: none;
		color: var(--primary-foreground);
		background: var(--primary);
		border-radius: var(--radius-md);
		transition: filter 150ms ease;
	}

	.feature-announcement__cta:hover {
		filter: brightness(1.08);
	}

	.feature-announcement__dismiss {
		flex-shrink: 0;
		display: grid;
		place-items: center;
		width: 2rem;
		height: 2rem;
		color: var(--muted-foreground);
		background: transparent;
		border: 0;
		border-radius: var(--radius-sm);
		cursor: pointer;
	}

	.feature-announcement__dismiss:hover {
		color: var(--foreground);
		background: var(--accent);
	}

	@media (max-width: 640px) {
		.feature-announcement {
			flex-wrap: wrap;
			margin: 0.75rem 0.75rem 0;
		}

		.feature-announcement__copy {
			flex-basis: calc(100% - 3rem);
			order: 1;
		}

		.feature-announcement__badge {
			order: 0;
		}

		.feature-announcement__dismiss {
			order: 0;
			margin-left: auto;
		}

		.feature-announcement__cta {
			order: 2;
		}
	}
</style>

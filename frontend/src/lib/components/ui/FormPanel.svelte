<script lang="ts">
	export let badge: string = '';
	export let badgeVariant: 'purple' | 'blue' | 'amber' = 'purple';
	export let title: string = '';
	export let subtitle: string = '';
</script>

<section class="form-panel">
	{#if badge || title || subtitle}
		<header class="form-panel__header">
			{#if badge}
				<span class="form-panel__badge" class:form-panel__badge--blue={badgeVariant === 'blue'} class:form-panel__badge--amber={badgeVariant === 'amber'}>{badge}</span>
			{/if}
			{#if title}
				<h2 class="form-panel__title">{title}</h2>
			{/if}
			{#if subtitle}
				<p class="form-panel__subtitle">{subtitle}</p>
			{/if}
		</header>
	{/if}

	<div class="form-panel__content">
		<slot />
	</div>

	{#if $$slots.footer}
		<footer class="form-panel__footer">
			<slot name="footer" />
		</footer>
	{/if}
</section>

<style>
	.form-panel {
		width: 480px;
		background: var(--color-surface-alt);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		padding: 1.75rem;
		transition: border-color 150ms ease;
		font-family: var(--font-body);
	}

	.form-panel:hover {
		border-color: var(--color-border-strong);
	}

	.form-panel__header {
		margin-bottom: 1.5rem;
	}

	.form-panel__badge {
		display: inline-flex;
		align-items: center;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--color-primary-deep);
		background: var(--color-primary-soft);
		border: 1px solid var(--color-primary);
		padding: 0.1875rem 0.625rem;
		margin-bottom: 0.625rem;
	}

	.form-panel__badge--blue {
		color: var(--color-info);
		background: rgba(63, 94, 166, 0.1);
		border-color: var(--color-info);
	}

	.form-panel__badge--amber {
		color: var(--color-secondary);
		background: var(--color-secondary-soft);
		border-color: var(--color-secondary);
	}

	.form-panel__title {
		font-family: var(--font-display);
		font-size: 1.625rem;
		font-weight: 600;
		color: var(--color-ink);
		margin: 0 0 0.375rem 0;
		line-height: 1.15;
		letter-spacing: -0.02em;
	}

	.form-panel__subtitle {
		font-size: 0.9375rem;
		font-weight: 500;
		color: var(--color-ink-muted);
		margin: 0;
		line-height: 1.55;
	}

	.form-panel__footer {
		margin-top: 1.5rem;
		padding-top: 1.25rem;
		border-top: 1px solid var(--color-border);
	}
</style>

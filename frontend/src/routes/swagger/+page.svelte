<script lang="ts">
	import { onMount } from 'svelte';
	import { HOSTED_AGENT_TARGET, isHostedScoutpostHost } from '$lib/utils/agent-targets';

	const SWAGGER_VERSION = '5.17.14';
	const SWAGGER_CSS = `https://unpkg.com/swagger-ui-dist@${SWAGGER_VERSION}/swagger-ui.css`;
	const SWAGGER_BUNDLE = `https://unpkg.com/swagger-ui-dist@${SWAGGER_VERSION}/swagger-ui-bundle.js`;
	const SWAGGER_PRESET = `https://unpkg.com/swagger-ui-dist@${SWAGGER_VERSION}/swagger-ui-standalone-preset.js`;

	const supabaseUrl = (import.meta.env.PUBLIC_SUPABASE_URL ?? '').replace(/\/$/, '');
	const hostedBroker =
		typeof window !== 'undefined' &&
		isHostedScoutpostHost(window.location.hostname);
	const specUrl = hostedBroker
		? `${HOSTED_AGENT_TARGET.apiBaseUrl}/openapi-spec`
		: supabaseUrl
			? `${supabaseUrl}/functions/v1/openapi-spec`
			: '/api/openapi.json';

	let container: HTMLDivElement;
	let errorMessage: string | null = null;

	function loadScript(src: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
			if (existing) {
				if (existing.dataset.loaded === 'true') return resolve();
				existing.addEventListener('load', () => resolve());
				existing.addEventListener('error', () => reject(new Error(`failed to load ${src}`)));
				return;
			}
			const s = document.createElement('script');
			s.src = src;
			s.crossOrigin = 'anonymous';
			s.addEventListener('load', () => {
				s.dataset.loaded = 'true';
				resolve();
			});
			s.addEventListener('error', () => reject(new Error(`failed to load ${src}`)));
			document.head.appendChild(s);
		});
	}

	function ensureStylesheet(href: string) {
		if (document.querySelector(`link[rel="stylesheet"][href="${href}"]`)) return;
		const link = document.createElement('link');
		link.rel = 'stylesheet';
		link.href = href;
		link.crossOrigin = 'anonymous';
		document.head.appendChild(link);
	}

	onMount(async () => {
		try {
			ensureStylesheet(SWAGGER_CSS);
			await loadScript(SWAGGER_BUNDLE);
			await loadScript(SWAGGER_PRESET);

			// @ts-expect-error — SwaggerUIBundle is attached to window by the CDN bundle
			const bundle = window.SwaggerUIBundle;
			// @ts-expect-error — same
			const preset = window.SwaggerUIStandalonePreset;
			if (!bundle || !preset) throw new Error('Swagger UI failed to initialise');

			bundle({
				url: specUrl,
				domNode: container,
				deepLinking: true,
				presets: [bundle.presets.apis, preset.slice(1)],
				layout: 'BaseLayout',
				defaultModelsExpandDepth: 1,
				defaultModelExpandDepth: 1,
				tryItOutEnabled: true,
				persistAuthorization: true
			});
		} catch (e) {
			errorMessage = e instanceof Error ? e.message : 'Failed to load Swagger UI';
		}
	});
</script>

<svelte:head>
	<title>Scoutpost — API Reference</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<nav class="topbar">
	<a class="back" href="/">&larr; Back to Scoutpost</a>
	<a class="raw" href={specUrl} target="_blank" rel="noopener noreferrer">Raw OpenAPI JSON</a>
</nav>

{#if errorMessage}
	<div class="error">
		<p><strong>Could not load the API reference.</strong></p>
		<p>{errorMessage}</p>
		<p>Raw spec: <a href={specUrl} target="_blank" rel="noopener noreferrer">{specUrl}</a></p>
	</div>
{/if}

<div class="swagger-shell" bind:this={container}></div>

<style>
	.topbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.875rem 1.5rem;
		border-bottom: 1px solid var(--color-border);
		background: var(--color-surface-alt);
		font-size: 0.8125rem;
	}
	.topbar a {
		color: var(--color-ink-muted);
		text-decoration: none;
		font-weight: 500;
	}
	.topbar a:hover {
		color: var(--color-primary);
	}
	.error {
		padding: 1.25rem 1.5rem;
		background: color-mix(in oklab, var(--color-error) 12%, var(--color-bg));
		color: var(--color-error);
		border-bottom: 1px solid color-mix(in oklab, var(--color-error) 35%, var(--color-border));
	}
	.error p {
		margin: 0 0 0.375rem 0;
		font-size: 0.8125rem;
	}
	.error p:last-child {
		margin-bottom: 0;
	}
	.swagger-shell {
		min-height: calc(100vh - 3rem);
		background: var(--color-bg);
	}
	.swagger-shell :global(.swagger-ui .topbar) {
		display: none;
	}
	.swagger-shell :global(.swagger-ui) {
		color: var(--color-ink);
		font-family: var(--font-body);
	}
	.swagger-shell :global(.swagger-ui .info .title),
	.swagger-shell :global(.swagger-ui .info p),
	.swagger-shell :global(.swagger-ui .info li),
	.swagger-shell :global(.swagger-ui .opblock-tag),
	.swagger-shell :global(.swagger-ui .opblock-summary-path),
	.swagger-shell :global(.swagger-ui .opblock-description-wrapper p),
	.swagger-shell :global(.swagger-ui .response-col_status),
	.swagger-shell :global(.swagger-ui .responses-inner h4),
	.swagger-shell :global(.swagger-ui .responses-inner h5),
	.swagger-shell :global(.swagger-ui table thead tr td),
	.swagger-shell :global(.swagger-ui table thead tr th),
	.swagger-shell :global(.swagger-ui .model-title),
	.swagger-shell :global(.swagger-ui .model),
	.swagger-shell :global(.swagger-ui .parameter__name),
	.swagger-shell :global(.swagger-ui .tab li),
	.swagger-shell :global(.swagger-ui .btn),
	.swagger-shell :global(.swagger-ui .servers > label),
	.swagger-shell :global(.swagger-ui .scheme-container .schemes > .schemes-server-container > label),
	.swagger-shell :global(.swagger-ui .markdown pre),
	.swagger-shell :global(.swagger-ui .renderedMarkdown pre) {
		color: var(--color-ink);
	}
	.swagger-shell :global(.swagger-ui .opblock-tag small),
	.swagger-shell :global(.swagger-ui .opblock-summary-description),
	.swagger-shell :global(.swagger-ui .parameter__type) {
		color: var(--color-ink-muted);
	}
	.swagger-shell :global(.swagger-ui .scheme-container),
	.swagger-shell :global(.swagger-ui section.models),
	.swagger-shell :global(.swagger-ui .opblock),
	.swagger-shell :global(.swagger-ui input),
	.swagger-shell :global(.swagger-ui select),
	.swagger-shell :global(.swagger-ui textarea) {
		background: var(--color-surface-alt);
		color: var(--color-ink);
		border-color: var(--color-border);
		box-shadow: none;
	}
	.swagger-shell :global(.swagger-ui .opblock),
	.swagger-shell :global(.swagger-ui section.models),
	.swagger-shell :global(.swagger-ui input),
	.swagger-shell :global(.swagger-ui select),
	.swagger-shell :global(.swagger-ui textarea),
	.swagger-shell :global(.swagger-ui .btn) {
		border-radius: var(--radius-md);
	}
	.swagger-shell :global(.swagger-ui .expand-operation svg),
	.swagger-shell :global(.swagger-ui .models-control svg),
	.swagger-shell :global(.swagger-ui .authorization__btn svg) {
		fill: var(--color-ink-muted);
	}
	.swagger-shell :global(.swagger-ui .highlight-code),
	.swagger-shell :global(.swagger-ui .microlight) {
		background: oklch(0.18 0.01 215) !important;
		color: var(--color-ink) !important;
	}
</style>

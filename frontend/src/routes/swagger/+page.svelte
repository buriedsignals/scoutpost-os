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
		border-bottom: 1px solid #e5e7eb;
		background: #ffffff;
		font-size: 0.8125rem;
	}
	.topbar a {
		color: #4b5563;
		text-decoration: none;
		font-weight: 500;
	}
	.topbar a:hover {
		color: #4E2C78;
	}
	.error {
		padding: 1.25rem 1.5rem;
		background: #fef2f2;
		color: #991b1b;
		border-bottom: 1px solid #fecaca;
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
		background: #fafafa;
	}
	:global(.swagger-ui .topbar) {
		display: none;
	}
</style>

<script lang="ts">
	import { ArrowLeft } from 'lucide-svelte';
</script>

<svelte:head>
	<title>Acknowledgements — Scoutpost</title>
	<meta name="description" content="The open-source projects Scoutpost is built on — scraping, evidence archiving, search, and monitoring tools we're grateful to." />
</svelte:head>

<div class="ack-page">
	<div class="bg-pattern"></div>

	<div class="content">
		<a class="back-button" href="/">
			<ArrowLeft class="w-4 h-4" />
			<span>Back</span>
		</a>

		<header class="header">
			<div class="badge">Acknowledgements</div>
			<h1 class="title">
				Standing on <span class="gradient-text">open work</span>
			</h1>
			<p class="subtitle">
				Scoutpost is built on community-maintained open-source projects that do the
				heavy operational lifting. A sincere thank-you to every project below —
				listing does not imply affiliation or endorsement.
			</p>
		</header>

		<div class="ack-list">
			<section class="ack-section">
				<h2 class="section-title">Scraping &amp; browser automation</h2>
				<ul class="credits">
					<li><a href="https://github.com/unclecode/crawl4ai" target="_blank" rel="noopener">Crawl4AI</a> — unclecode · the primary scraper behind Page, Beat, and Civic Scouts · Apache-2.0</li>
					<li><a href="https://playwright.dev/" target="_blank" rel="noopener">Playwright</a> — browser automation under the scraper</li>
					<li><a href="https://poppler.freedesktop.org/" target="_blank" rel="noopener">Poppler</a> — <code>pdftotext</code> · civic-PDF extraction</li>
				</ul>
			</section>

			<section class="ack-section">
				<h2 class="section-title">Application runtime</h2>
				<ul class="credits">
					<li><a href="https://deno.com/" target="_blank" rel="noopener">Deno</a> — runs the <code>scout</code> CLI, the MCP bridge, and every Edge Function · MIT</li>
					<li><a href="https://fastapi.tiangolo.com/" target="_blank" rel="noopener">FastAPI</a> — Sebastián Ramírez · the backend API · MIT</li>
				</ul>
			</section>

			<section class="ack-section">
				<h2 class="section-title">Search &amp; analysis</h2>
				<ul class="credits">
					<li><a href="https://github.com/pgvector/pgvector" target="_blank" rel="noopener">pgvector</a> — Andrew Kane · vector search behind semantic scout matching</li>
					<li><a href="https://github.com/Mimino666/langdetect" target="_blank" rel="noopener">langdetect</a> — language detection in dedup scoring</li>
				</ul>
			</section>

			<section class="ack-section">
				<h2 class="section-title">Evidence archiving</h2>
				<ul class="credits">
					<li><a href="https://web.archive.org/" target="_blank" rel="noopener">Internet Archive / Wayback Machine</a> — optional evidence-snapshot submission</li>
				</ul>
			</section>

			<section class="ack-section">
				<h2 class="section-title">Fleet &amp; transport data</h2>
				<ul class="credits">
					<li><a href="https://adsb.lol/" target="_blank" rel="noopener">adsb.lol</a> — community-run ADS-B network · live aircraft positions</li>
					<li><a href="https://celestrak.org/" target="_blank" rel="noopener">CelesTrak</a> — T.S. Kelso · satellite orbital elements, freely published since 1985</li>
					<li><a href="https://aisstream.io/" target="_blank" rel="noopener">aisstream.io</a> — live vessel positions from community AIS receivers</li>
					<li><a href="https://github.com/shashwatak/satellite-js" target="_blank" rel="noopener">satellite.js</a> — shashwatak · orbital math · MIT</li>
				</ul>
			</section>
		</div>

		<p class="footer-note">
			Built something we should credit, or want a listing changed or removed?
			<a href="https://github.com/buriedsignals/scoutpost-os/issues" target="_blank" rel="noopener">Open an issue or PR</a> — we'll fix it fast.
		</p>
	</div>
</div>

<style>
	/* Acknowledgements — plum + ochre on cream, matches /faq */
	.ack-page {
		min-height: 100vh;
		background: var(--color-bg);
		color: var(--color-ink);
		position: relative;
		overflow-x: hidden;
		font-family: var(--font-body);
	}

	.bg-pattern {
		position: absolute;
		inset: 0;
		background-image:
			linear-gradient(to right, var(--color-border) 1px, transparent 1px),
			linear-gradient(to bottom, var(--color-border) 1px, transparent 1px);
		background-size: 96px 96px;
		opacity: 0.35;
		pointer-events: none;
		mask-image: linear-gradient(to bottom, black 0%, black 40%, transparent 95%);
		-webkit-mask-image: linear-gradient(to bottom, black 0%, black 40%, transparent 95%);
	}

	.content {
		position: relative;
		z-index: 1;
		max-width: 720px;
		margin: 0 auto;
		padding: 2rem 1.5rem 4rem;
	}

	.back-button {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.875rem;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--color-ink-muted);
		background: var(--color-surface-alt);
		border: 1px solid var(--color-border);
		cursor: pointer;
		margin-bottom: 2rem;
		transition: border-color 150ms ease, color 150ms ease;
		text-decoration: none;
	}

	.back-button:hover {
		border-color: var(--color-primary);
		color: var(--color-primary);
	}

	.header {
		text-align: left;
		margin-bottom: 3rem;
		padding-bottom: 2rem;
		border-bottom: 1px solid var(--color-border);
	}

	.badge {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--color-secondary);
		margin-bottom: 1rem;
	}

	.title {
		font-family: var(--font-display);
		font-size: clamp(2rem, 4.5vw, 2.75rem);
		font-weight: 600;
		line-height: 1.1;
		letter-spacing: -0.02em;
		margin-bottom: 1rem;
		color: var(--color-ink);
	}

	.gradient-text {
		color: var(--color-primary);
	}

	.subtitle {
		font-size: 1.0625rem;
		font-weight: 300;
		color: var(--color-ink-muted);
		max-width: 560px;
		margin: 0;
		line-height: 1.55;
	}

	.ack-list {
		display: flex;
		flex-direction: column;
		gap: 2.5rem;
	}

	.section-title {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--color-secondary);
		margin-bottom: 1rem;
		padding-bottom: 0.5rem;
		border-bottom: 1px solid var(--color-border);
	}

	.credits {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
	}

	.credits li {
		font-size: 0.9375rem;
		font-weight: 300;
		color: var(--color-ink-muted);
		line-height: 1.7;
	}

	.credits a {
		color: var(--color-primary);
		font-weight: 500;
		text-decoration: none;
		border-bottom: 1px solid var(--color-primary-soft);
		transition: border-color 150ms ease;
	}

	.credits a:hover {
		border-bottom-color: var(--color-primary);
	}

	.credits code {
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		padding: 0.125rem 0.375rem;
		background: var(--color-surface);
		color: var(--color-ink);
		border: 1px solid var(--color-border);
	}

	.footer-note {
		text-align: left;
		font-family: var(--font-mono);
		font-size: 0.75rem;
		letter-spacing: 0.06em;
		color: var(--color-ink-subtle);
		margin-top: 3rem;
	}

	.footer-note a {
		color: var(--color-primary);
		text-decoration: none;
		border-bottom: 1px solid var(--color-primary-soft);
		transition: border-color 150ms ease;
	}

	.footer-note a:hover {
		border-bottom-color: var(--color-primary);
	}

	@media (max-width: 640px) {
		.content {
			padding: 1.5rem 1rem 3rem;
		}
	}
</style>

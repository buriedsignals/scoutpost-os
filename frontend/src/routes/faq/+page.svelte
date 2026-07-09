<script lang="ts">
	import { ArrowLeft } from 'lucide-svelte';
</script>

<svelte:head>
	<title>FAQ — Scoutpost</title>
	<meta name="description" content="Frequently asked questions about Scoutpost — AI scouts, agent integration, the Sustainable Use License, hosted accounts, and self-hosting." />
	<link rel="alternate" type="text/plain" title="faq.txt" href="/faq.txt" />
	<link rel="alternate" type="text/markdown" title="Scoutpost skill" href="/skills/scoutpost.md" />
	<link rel="alternate" type="text/markdown" title="Scoutpost setup skill" href="/skills/scoutpost-setup.md" />
</svelte:head>

<div class="faq-page">
	<div class="bg-pattern"></div>
	<div class="bg-gradient"></div>

	<div class="content">
		<a class="back-button" href="/login">
			<ArrowLeft class="w-4 h-4" />
			<span>Back</span>
		</a>

		<header class="header">
			<div class="badge">FAQ</div>
			<h1 class="title">
				Frequently Asked <span class="gradient-text">Questions</span>
			</h1>
			<p class="subtitle">Licensing, self-hosting, and how Scoutpost works for newsrooms.</p>
		</header>

		<div class="faq-list">
			<section class="faq-section">
				<h2 class="section-title">Licensing</h2>

				<details class="faq-item">
					<summary class="faq-question">What license does Scoutpost use?</summary>
					<div class="faq-answer">
						<p>Scoutpost uses the <strong>Sustainable Use License</strong>, a fair-code license. It allows free use, modification, and redistribution for internal purposes, with restrictions on reselling or offering the software as a hosted service.</p>
					</div>
				</details>

				<details class="faq-item">
					<summary class="faq-question">Can I use Scoutpost in my newsroom?</summary>
					<div class="faq-answer">
						<p><strong>Yes.</strong> You can deploy, modify, and use Scoutpost for your newsroom's internal operations — monitoring beats, tracking sources, generating leads, and producing content. This is exactly what the license is designed for.</p>
					</div>
				</details>

				<details class="faq-item">
					<summary class="faq-question">Can I modify the code?</summary>
					<div class="faq-answer">
						<p><strong>Yes.</strong> You can modify Scoutpost to fit your newsroom's needs — add custom scout types, change the UI, integrate with your CMS, or adapt it for your editorial workflow. Your modifications are for your internal use.</p>
					</div>
				</details>

				<details class="faq-item">
					<summary class="faq-question">What am I NOT allowed to do?</summary>
					<div class="faq-answer">
						<ul>
							<li><strong>Resell it</strong> — you cannot sell Scoutpost or a derivative as a standalone product</li>
							<li><strong>Offer it as a service</strong> — you cannot host it and charge others for access (SaaS, managed service)</li>
							<li><strong>White-label it</strong> — you cannot rebrand it and distribute it as your own product</li>
						</ul>
						<p>In short: use it for your journalism, don't compete with us by selling it.</p>
					</div>
				</details>

				<details class="faq-item">
					<summary class="faq-question">Is Scoutpost open source?</summary>
					<div class="faq-answer">
						<p>Scoutpost is <strong>source-available</strong> under the Sustainable Use License. All code is public and readable on GitHub. The license is more permissive than proprietary software but more restrictive than MIT or Apache 2.0 — specifically, it prevents using the software to compete with the original product. This is the same model used by <a href="https://n8n.io" target="_blank" rel="noopener noreferrer">n8n</a>, <a href="https://cal.com" target="_blank" rel="noopener noreferrer">Cal.com</a>, and other fair-code projects.</p>
					</div>
				</details>
			</section>

			<section class="faq-section">
				<h2 class="section-title">Self-hosting</h2>

				<details class="faq-item">
					<summary class="faq-question">How do I deploy Scoutpost on my own infrastructure?</summary>
					<div class="faq-answer">
						<p>The GitHub repo ships with an <strong>automated setup flow</strong>. Drop any AI coding agent (Claude Code, Cursor, Codex, etc.) into the repo, invoke the setup skill, and it provisions everything end-to-end: a fresh Supabase project, the edge functions, and the frontend.</p>
						<p>Manual deployment is also documented in <code>selfhost/SETUP_AGENT.md</code> and <code>deploy/SETUP.md</code> — nothing is gated.</p>
					</div>
				</details>

				<details class="faq-item">
					<summary class="faq-question">What do I need to provide?</summary>
					<div class="faq-answer">
						<p>You bring your own API keys and hosting:</p>
						<ul>
							<li><strong>Supabase</strong> — managed (supabase.com) or self-hosted via Docker</li>
							<li><strong>Gemini API key</strong> — for AI analysis and embeddings</li>
							<li><strong>Firecrawl API key</strong> — for web scraping and search</li>
							<li><strong>Resend API key</strong> — for email notifications</li>
							<li><strong>Apify API token</strong> — for social media monitoring</li>
							<li><strong>Hosting</strong> — Render, Docker, or any platform that serves a SvelteKit static build</li>
						</ul>
					</div>
				</details>

				<details class="faq-item">
					<summary class="faq-question">How do I stay up to date?</summary>
					<div class="faq-answer">
						<p>A GitHub Actions workflow (<code>sync-upstream</code>) periodically pulls the latest release from the public repository into your fork and opens a PR. Merge the PR and redeploy — no manual migration work. Set the workflow schedule (daily, weekly, manual) to suit your newsroom.</p>
					</div>
				</details>

				<details class="faq-item">
					<summary class="faq-question">Does self-hosting cost anything?</summary>
					<div class="faq-answer">
						<p><strong>Nothing to us.</strong> Scoutpost itself is free to self-host under the Sustainable Use License. Your only costs are the third-party services you connect (Supabase, Gemini, Firecrawl, Resend, Apify) and whatever hosting you choose for the frontend.</p>
					</div>
				</details>
			</section>

			<section class="faq-section">
				<h2 class="section-title">Product</h2>

				<details class="faq-item">
					<summary class="faq-question">What is Scoutpost?</summary>
					<div class="faq-answer">
						<p>Scoutpost is an AI-powered local news monitoring platform, formerly called coJournalist. It helps journalists and newsrooms track beats, monitor sources, and surface story leads through automated scouts that watch the web, social media, and government pages on a schedule.</p>
					</div>
				</details>

				<details class="faq-item">
					<summary class="faq-question">What's the difference between the hosted and self-hosted versions?</summary>
					<div class="faq-answer">
						<p><strong>Hosted (scoutpost.ai)</strong> — we run everything. Sign in with MuckRock, pay per credits, no setup needed.</p>
						<p><strong>Self-hosted</strong> — you run it on your own infrastructure (Supabase + a static host). No credit limits, full control, bring your own API keys. Free, open source, and the same feature set as hosted.</p>
					</div>
				</details>
			</section>

			<section class="faq-section" id="open-source">
				<h2 class="section-title">Open source</h2>

				<details class="faq-item">
					<summary class="faq-question">What open-source projects is Scoutpost built on?</summary>
					<div class="faq-answer">
						<p>Scoutpost stands on community-maintained open-source projects that do the heavy operational lifting. We're grateful to:</p>
						<ul>
							<li><a href="https://github.com/unclecode/crawl4ai" target="_blank" rel="noopener">Crawl4AI</a> — the primary scraper behind Page, Beat, and Civic Scouts</li>
							<li><a href="https://playwright.dev/" target="_blank" rel="noopener">Playwright</a> — browser automation under the scraper</li>
							<li><a href="https://poppler.freedesktop.org/" target="_blank" rel="noopener">Poppler</a> — <code>pdftotext</code>, for civic-PDF extraction</li>
							<li><a href="https://web.archive.org/" target="_blank" rel="noopener">Internet Archive / Wayback Machine</a> — optional evidence-snapshot submission</li>
							<li><a href="https://github.com/shashwatak/satellite-js" target="_blank" rel="noopener">satellite.js</a> — orbital math for the Transport Scout</li>
						</ul>
						<p>Built something we should credit, or want a listing changed? <a href="https://github.com/buriedsignals/scoutpost-os/issues" target="_blank" rel="noopener">Open an issue or PR</a> — we'll fix it fast.</p>
					</div>
				</details>
			</section>
		</div>

		<p class="footer-note">
			More questions? <a href="https://github.com/buriedsignals/scoutpost-os/issues" target="_blank" rel="noopener">Open an issue on GitHub</a>.
			AI resources live at <a href="/skills">/skills</a> and <a href="/faq.txt">/faq.txt</a>.
		</p>
	</div>
</div>

<style>
	/* FAQ — plum + ochre on cream */
	.faq-page {
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

	.bg-gradient {
		display: none;
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

	.faq-list {
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

	.faq-item {
		background: var(--color-surface-alt);
		border: 1px solid var(--color-border);
		border-top-width: 0;
		transition: background 150ms ease, border-color 150ms ease;
	}

	.faq-section > details:first-of-type {
		border-top-width: 1px;
	}

	.faq-item:hover {
		background: var(--color-bg);
	}

	.faq-item[open] {
		background: var(--color-bg);
		border-color: var(--color-border-strong);
	}

	.faq-question {
		padding: 1rem 1.25rem;
		font-family: var(--font-body);
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--color-ink);
		cursor: pointer;
		list-style: none;
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.faq-question::-webkit-details-marker {
		display: none;
	}

	.faq-question::after {
		content: '+';
		font-family: var(--font-mono);
		font-size: 1.125rem;
		font-weight: 300;
		color: var(--color-ink-subtle);
		transition: color 150ms ease;
	}

	.faq-item[open] .faq-question::after {
		content: '−';
		color: var(--color-primary);
	}

	.faq-answer {
		padding: 0 1.25rem 1.25rem;
		font-family: var(--font-body);
		font-size: 0.9375rem;
		font-weight: 300;
		color: var(--color-ink-muted);
		line-height: 1.7;
	}

	.faq-answer p {
		margin: 0 0 0.75rem;
	}

	.faq-answer p:last-child {
		margin-bottom: 0;
	}

	.faq-answer ul {
		margin: 0.5rem 0;
		padding-left: 1.25rem;
	}

	.faq-answer li {
		margin-bottom: 0.5rem;
	}

	.faq-answer a {
		color: var(--color-primary);
		text-decoration: none;
		border-bottom: 1px solid var(--color-primary-soft);
		transition: border-color 150ms ease;
	}

	.faq-answer a:hover {
		border-bottom-color: var(--color-primary);
	}

	.faq-answer code {
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

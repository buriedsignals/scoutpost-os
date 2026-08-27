<script>
	// Public page — no auth required
</script>

<svelte:head>
	<title>Terms & Privacy — Scoutpost</title>
	<meta name="description" content="Scoutpost terms of use and privacy policy for hosted and self-hosted newsroom deployments." />
</svelte:head>

<div class="terms-page">
	<div class="terms-content">
		<a href="/" class="back-link">&larr; Back to Scoutpost</a>

		<h1>Terms of Use & Privacy Policy</h1>
		<p class="updated">Last updated: August 27, 2026</p>

		<section>
			<h2>What Scoutpost Is</h2>
			<p>
				Scoutpost, formerly coJournalist, is an AI-powered research assistant for journalists. It monitors websites, local news sources, social media, and government documents on your behalf, and delivers findings via email and dashboard.
			</p>
			<p>
				<strong>It is not a news source.</strong> All content displayed in the dashboard, delivered via email, and generated in export drafts is produced or processed by artificial intelligence. This includes extracted facts, article summaries, translated titles, filtered search results, and draft articles.
			</p>
		</section>

		<section>
			<h2>AI Content &mdash; Read This</h2>
			<p>
				AI-generated content may contain errors, omissions, hallucinations, or misattributions. Scoutpost does not verify the accuracy of extracted information. Specifically:
			</p>
			<ul>
				<li>Extracted facts may be incomplete, taken out of context, or wrong</li>
				<li>The AI filter may exclude relevant articles from your results</li>
				<li>Translated titles may distort the original meaning</li>
				<li>Export drafts may contain fabricated connecting details or inferred causation</li>
				<li>Source reliability varies &mdash; community and independent sources have no editorial oversight</li>
			</ul>
			<p>
				<strong>You are solely responsible for independently verifying all information before publication.</strong> Treat Scoutpost output as unverified leads, not confirmed reporting. We are not liable for editorial decisions made based on AI-generated content.
			</p>
		</section>

		<section>
			<h2>Your Responsibilities</h2>
			<p>
				When you use Page Scout, Civic Scout, or Social Scout, you are responsible for ensuring that use complies with applicable target website and platform terms. You must comply with the <a href="/source-service-constraints.json">verified source and service constraints</a> that apply.
			</p>
			<p>
				Social Scout monitors publicly accessible personal profiles only. If Scoutpost cannot confirm that an account is a public profile, it warns you and continues; you remain responsible for confirming the account is public.
			</p>
		</section>

		<section>
			<h2 id="acceptable-use">Acceptable Use</h2>
			<p>
				Scoutpost is for investigative work with a public-service purpose. It must not be used for personal surveillance, harassment, coercive employee monitoring, stalking, or retaliation.
			</p>
			<p>The following uses are prohibited:</p>
			<ul>
				<li><strong>AUP-PRIVATE-ACCESS</strong> &mdash; Unauthorized access to private content or circumvention of access controls is prohibited.</li>
				<li><strong>AUP-STALKING-HARASSMENT-DOXXING</strong> &mdash; Using Scoutpost for stalking, harassment, or doxxing is prohibited.</li>
				<li><strong>AUP-COERCIVE-DISCRIMINATORY-SURVEILLANCE</strong> &mdash; Coercive or discriminatory surveillance, including coercive employee monitoring, is prohibited.</li>
				<li><strong>AUP-PROMPT-INJECTION</strong> &mdash; Prompt injection attempts to override Scoutpost instructions are prohibited.</li>
				<li><strong>AUP-RATE-LIMIT-ABUSE</strong> &mdash; Rate-limit abuse of Scoutpost or source services is prohibited.</li>
				<li><strong>AUP-MISINFORMATION</strong> &mdash; Using Scoutpost to generate or amplify misinformation is prohibited.</li>
			</ul>
			<p>
				Monitoring a publicly accessible personal profile for a legitimate public-interest purpose is not by itself a violation. Attempting to access private content is prohibited.
			</p>
			<p>
				Potential violations receive operator review; model output alone is never proof. High-confidence findings require corroborating evidence and a cited published rule. An operator may terminate an account after review of relevant logs and may share those logs when appropriate and lawful. Scoutpost takes no enforcement action without that review.
			</p>
			<p>
				The stable rule identifiers, evidence requirements, and uncertainty treatment are published in the <a href="/acceptable-use-policy.json">machine-readable acceptable-use policy</a>.
			</p>
		</section>

		<section>
			<h2>No Warranty</h2>
			<p>
				Scoutpost is provided "as is" without warranty of any kind. We do not guarantee completeness of search results, accuracy of translations, availability of social media scraping (platform changes may cause failures), or continuity of any feature or data source.
			</p>
			<p>
				AI filtering may exclude relevant articles. The system searches a subset of available sources. Important stories may be missed. Scoutpost supplements but does not replace your own monitoring and sourcing.
			</p>
		</section>

		<section>
			<h2>Intellectual Property</h2>
			<p>
				You own the content you create using Scoutpost's export feature. AI-generated drafts are tools for your editorial process &mdash; we claim no rights over your published work.
			</p>
		</section>

		<section>
			<h2>Account & Deletion</h2>
			<p>
				Self-hosted deployments use the authentication and account-deletion process configured by the newsroom.
			</p>
		</section>

		<hr />

		<h1 id="privacy">Privacy Policy</h1>

		<section>
			<h2>What We Collect</h2>
			<ul>
				<li><strong>User ID</strong> &mdash; an opaque Supabase user identifier</li>
				<li><strong>Scout configurations</strong> &mdash; URLs, locations, topics, criteria, schedules you set up</li>
				<li><strong>Location data</strong> &mdash; city, country, and coordinates for geo-targeted scouts</li>
				<li><strong>Extracted facts</strong> &mdash; AI-extracted statements, source URLs, dates, entities</li>
				<li><strong>Social post content</strong> &mdash; public post text and metadata collected by Social Scouts</li>
				<li><strong>Execution history</strong> &mdash; when scouts ran and what they found</li>
				<li><strong>Usage records</strong> &mdash; credit consumption for billing</li>
				<li><strong>Abuse-review records</strong> &mdash; policy rule, deterministic evidence, confidence, model rationale, notification state, and operator disposition for potentially abusive scout configurations</li>
			</ul>
		</section>

		<section>
			<h2>What We Don't Collect</h2>
			<ul>
				<li>Passwords in application storage (authentication is handled by Supabase Auth)</li>
				<li>Analytics, behavioral tracking, or advertising data</li>
				<li>Browsing history or usage patterns</li>
			</ul>
		</section>

		<section>
			<h2>Third-Party Processors</h2>
			<p>Your data is processed by:</p>
			<table>
				<thead>
					<tr><th>Service</th><th>Purpose</th><th>Data Shared</th></tr>
				</thead>
				<tbody>
					<tr><td>Supabase</td><td>Authentication, database, edge functions</td><td>Account identity and stored application data</td></tr>
					<tr><td>OpenRouter</td><td>AI gateway and billing intermediary</td><td>Article and social post text, search queries, images used for relevance, low-yield/scanned PDFs, and minimal candidate-abuse-review scout fields with the account identity removed</td></tr>
					<tr><td>Google Vertex</td><td>Upstream Gemini model inference</td><td>The same AI inputs routed by OpenRouter</td></tr>
					<tr><td>Firecrawl</td><td>Web scraping</td><td>URLs you provide</td></tr>
					<tr><td>Apify and Community Actor creators</td><td>Social media scraping</td><td>Social handles and public actor outputs; Creator access depends on the Actor permissions described in the verified service constraints</td></tr>
					<tr><td>Resend</td><td>Email delivery</td><td>Your email (per-send), notification content</td></tr>
					<tr><td>MapTiler</td><td>Geocoding</td><td>Location names</td></tr>
				</tbody>
			</table>
			<p>
				AI requests therefore follow Scoutpost &rarr; OpenRouter &rarr; Google Vertex. OpenRouter remains a processor; routing through it does not reduce the processor chain. Scoutpost restricts each request to Google Vertex, requests zero-data-retention routing, denies provider data collection, and disables OpenRouter response caching. Account-level logging and data-sharing settings provide additional protection.
			</p>
			<p>
				PDF text extraction normally runs locally with Poppler. Only low-yield or scanned PDFs are sent through the AI route for native Google PDF processing; Scoutpost forces the native PDF engine and does not use OpenRouter's Mistral or Cloudflare parsing options.
			</p>
		</section>

		<section>
			<h2>Data Retention</h2>
			<table>
				<thead>
					<tr><th>Data</th><th>Retention</th></tr>
				</thead>
				<tbody>
					<tr><td>Extracted facts and execution history</td><td>90 days (auto-deleted)</td></tr>
					<tr><td>Usage records</td><td>90 days; AI usage metadata 180 days</td></tr>
					<tr><td>Social comparison baselines</td><td>Active scout lifetime; 90 days after inactivity</td></tr>
					<tr><td>Potential abuse-review findings</td><td>180 days after the last matching review</td></tr>
					<tr><td>Page Archive evidence</td><td>Until you delete the Page Scout or account; no automatic expiry</td></tr>
					<tr><td>Scout configurations</td><td>Until you delete the scout</td></tr>
					<tr><td>User profile</td><td>Until account deletion</td></tr>
				</tbody>
			</table>
		</section>

		<section>
			<h2>Your Rights</h2>
			<p>You have the right to:</p>
			<ul>
				<li><strong>Access</strong> &mdash; request a copy of all data associated with your account</li>
				<li><strong>Deletion</strong> &mdash; request permanent deletion of all your data</li>
				<li><strong>Rectification</strong> &mdash; correct any inaccurate data</li>
				<li><strong>Portability</strong> &mdash; receive your data in a machine-readable format</li>
			</ul>
			<p>
				Data is processed in the region configured by your newsroom or hosting provider. EU users may lodge a complaint with their local data protection authority.
			</p>
		</section>

		<section>
			<h2>Cookies</h2>
			<p>
				Scoutpost uses the authentication storage mechanism configured for your deployment. Depending on your setup, this may include secure cookies or browser-managed session storage.
			</p>
			<p>
				We do not use analytics, tracking, or advertising cookies.
			</p>
		</section>

		<section>
			<h2>Contact</h2>
			<p>
				For data requests or to exercise your rights under GDPR: click the help icon inside the app — it opens a private channel to the maintainer. For general questions, open an issue on <a href="https://github.com/buriedsignals/scoutpost-os/issues" target="_blank" rel="noopener">GitHub</a>.
			</p>
			<p>
				Buried Signals &middot; Zurich, Switzerland
			</p>
		</section>
	</div>
</div>

<style>
	/* Terms & Privacy — Night Watch surface */
	.terms-page {
		min-height: 100vh;
		background: var(--color-bg);
		display: flex;
		justify-content: center;
		padding: 2rem 1rem 4rem;
	}

	.terms-content {
		max-width: 720px;
		width: 100%;
		font-family: var(--font-body);
		color: var(--color-ink);
		line-height: 1.7;
		font-weight: 500;
	}

	.back-link {
		display: inline-block;
		margin-bottom: 2rem;
		padding: 0.375rem 0.75rem;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--color-ink-muted);
		background: var(--color-surface-alt);
		border: 1px solid var(--color-border);
		text-decoration: none;
		transition: border-color 150ms ease, color 150ms ease;
	}

	.back-link:hover {
		border-color: var(--color-primary);
		color: var(--color-primary);
	}

	.back-link,
	.terms-content table {
		border-radius: var(--radius-lg);
	}

	h1 {
		font-family: var(--font-display);
		font-size: 2rem;
		font-weight: 600;
		line-height: 1.1;
		letter-spacing: -0.02em;
		color: var(--color-ink);
		margin-bottom: 0.25rem;
	}

	.updated {
		font-family: var(--font-mono);
		color: var(--color-ink-subtle);
		font-size: 0.6875rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		margin-bottom: 2rem;
	}

	h2 {
		font-family: var(--font-display);
		font-size: 1.25rem;
		font-weight: 600;
		color: var(--color-ink);
		margin-top: 2rem;
		margin-bottom: 0.5rem;
		letter-spacing: -0.01em;
	}

	section {
		margin-bottom: 0.5rem;
	}

	p {
		font-size: 0.9375rem;
		margin-bottom: 0.75rem;
		color: var(--color-ink-muted);
	}

	ul {
		font-size: 0.9375rem;
		margin: 0.5rem 0 0.75rem 1.25rem;
		color: var(--color-ink-muted);
	}

	li {
		margin-bottom: 0.35rem;
	}

	hr {
		border: none;
		border-top: 1px solid var(--color-border);
		margin: 3rem 0 2rem;
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.8125rem;
		margin: 0.75rem 0;
		background: var(--color-surface-alt);
		border: 1px solid var(--color-border);
	}

	th {
		text-align: left;
		font-family: var(--font-mono);
		font-weight: 500;
		color: var(--color-ink-muted);
		font-size: 0.6875rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		padding: 0.5rem 0.75rem;
		border-bottom: 1px solid var(--color-border-strong);
		background: var(--color-surface);
	}

	td {
		padding: 0.5rem 0.75rem;
		border-bottom: 1px solid var(--color-border);
		vertical-align: top;
		color: var(--color-ink);
	}

	tr:last-child td {
		border-bottom: 0;
	}

	a {
		color: var(--color-primary);
		text-decoration: none;
		border-bottom: 1px solid var(--color-primary-soft);
		transition: border-color 150ms ease;
	}

	a:hover {
		border-bottom-color: var(--color-primary);
	}

	strong {
		font-weight: 600;
		color: var(--color-ink);
	}
</style>

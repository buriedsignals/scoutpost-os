<script lang="ts">
	import {
		ArrowLeft,
		CheckCircle2,
		Download,
		ExternalLink,
		FileJson,
		Key,
		LockKeyhole,
		ShieldCheck,
		Terminal
	} from 'lucide-svelte';
	import SharpAction from '$lib/components/docs/SharpAction.svelte';
	import SharpCodeBlock from '$lib/components/docs/SharpCodeBlock.svelte';
	import { DOCKER_INSTALLER_IMAGE } from '$lib/setup/setup-generator';

	const installCommand = `mkdir -p scoutpost-install
cd scoutpost-install
curl -fsSLO https://raw.githubusercontent.com/buriedsignals/scoutpost-os/master/deploy/installer/scoutpost-setup.example.json
cp scoutpost-setup.example.json scoutpost-setup.json
chmod 600 scoutpost-setup.json
$EDITOR scoutpost-setup.json
docker run --rm -it \\
  -v "$PWD:/workspace" \\
  -v "$PWD/scoutpost-setup.json:/config/scoutpost-setup.json:ro" \\
  ${DOCKER_INSTALLER_IMAGE} install`;

	const doctorCommand = `docker run --rm -it \\
  -v "$PWD:/workspace" \\
  -v "$PWD/scoutpost-setup.json:/config/scoutpost-setup.json:ro" \\
  ${DOCKER_INSTALLER_IMAGE} doctor`;

	const updateCommand = `docker run --rm -it \\
  -v "$PWD:/workspace" \\
  -v "$HOME/.config/gh:/root/.config/gh:ro" \\
  -v "$PWD/scoutpost-setup.json:/config/scoutpost-setup.json:ro" \\
  ${DOCKER_INSTALLER_IMAGE} update`;

	type RequiredKey = {
		name: string;
		purpose: string;
		signup: string;
		signupLabel: string;
		optional?: boolean;
	};

	const requiredKeys: RequiredKey[] = [
		{
			name: 'OpenRouter API key',
			purpose:
				'Google Vertex extraction, summaries, classification, scanned-PDF fallback, and 768-dimensional Gemini embeddings.',
			signup: 'https://openrouter.ai/keys',
			signupLabel: 'openrouter.ai'
		},
		{
			name: 'Firecrawl API key',
			purpose: 'Page Scout, Civic Scout, and Beat Scout fallback scraping.',
			signup: 'https://www.firecrawl.dev/',
			signupLabel: 'firecrawl.dev'
		},
		{
			name: 'Exa API key',
			purpose:
				'Beat Scout retrieval. Beat search is Exa-only — without this key, Beat Scout runs fail (there is no Firecrawl search fallback). Not needed if you do not use Beat Scout.',
			signup: 'https://exa.ai/',
			signupLabel: 'exa.ai',
			optional: true
		},
		{
			name: 'Apify API token',
			purpose: 'Social Scout actor runs.',
			signup: 'https://console.apify.com/account/integrations',
			signupLabel: 'apify.com'
		},
		{
			name: 'Resend API key',
			purpose: 'Scout notification email delivery.',
			signup: 'https://resend.com/api-keys',
			signupLabel: 'resend.com'
		},
		{
			name: 'MapTiler API key',
			purpose: 'Location autocomplete and geocoding for Location Scout.',
			signup: 'https://cloud.maptiler.com/account/keys/',
			signupLabel: 'maptiler.com'
		},
		{
			name: 'Supabase access token',
			purpose: 'Non-interactive Supabase CLI auth for project create / migration push / Edge Functions deploy.',
			signup: 'https://supabase.com/dashboard/account/tokens',
			signupLabel: 'supabase.com'
		}
	];
</script>

<svelte:head>
	<title>Self-host setup - Scoutpost</title>
	<meta
		name="description"
		content="Docker-only self-host setup for Scoutpost. Keep deployment secrets local and mount the manifest read-only into the installer container."
	/>
</svelte:head>

<div class="setup-page">
	<div class="content">
		<SharpAction className="back-button" href="/docs" size="sm" variant="ghost">
			<ArrowLeft class="w-4 h-4" />
			<span>Back to docs</span>
		</SharpAction>

		<header class="header">
			<div class="eyebrow">SELF-HOST SETUP</div>
			<h1>Install Scoutpost with Docker</h1>
			<p>
				The supported self-host path is a local Docker operator container. Create the setup
				manifest on your machine, keep it out of Git, and mount it read-only when you run the
				installer.
			</p>
		</header>

		<section class="trust-panel" aria-label="Setup safety">
			<div>
				<ShieldCheck size={22} />
				<strong>No browser secret collection</strong>
				<span
					>API keys, service-role keys, JWT secrets, and deploy hooks stay in a local file.</span
				>
			</div>
			<div>
				<LockKeyhole size={22} />
				<strong>Read-only secret mount</strong>
				<span>The installer reads <code>scoutpost-setup.json</code> from <code>/config</code>.</span>
			</div>
			<div>
				<CheckCircle2 size={22} />
				<strong>Repeatable operator image</strong>
				<span>Git, Deno, Node, Supabase CLI, GitHub CLI, jq, and OpenSSL live in the container.</span>
			</div>
		</section>

		<section class="section">
			<div class="section-heading">
				<div class="eyebrow eyebrow--secondary">PREREQUISITES</div>
				<h2>What you need first</h2>
				<p class="section-lede">
					Install <a href="https://www.docker.com/products/docker-desktop/">Docker Desktop</a>
					(or Docker Engine on Linux) and authenticate Supabase. The installer container ships
					the rest: Git, Deno, Node 22, Supabase CLI, GitHub CLI, jq, and OpenSSL.
				</p>
			</div>
			<ul class="check-list">
				<li><CheckCircle2 size={16} /> Docker 24+ running locally</li>
				<li><CheckCircle2 size={16} /> A Supabase access token (Cloud) or a self-hosted Supabase project</li>
				<li><CheckCircle2 size={16} /> A frontend host (Netlify, Vercel, Cloudflare, Render, or manual)</li>
				<li><CheckCircle2 size={16} /> GitHub CLI auth at <code>~/.config/gh</code> if you want update PRs</li>
			</ul>
		</section>

		<section class="section">
			<div class="section-heading">
				<div class="eyebrow eyebrow--secondary">REQUIRED ACCOUNTS &amp; KEYS</div>
				<h2>Collect API keys before you fill the manifest</h2>
				<p class="section-lede">
					Every value sits in <code>scoutpost-setup.json</code> on your machine. The Docker
					installer never opens a browser login for these — paste them into the manifest,
					not into chat.
				</p>
			</div>
			<ul class="key-list">
				{#each requiredKeys as key (key.name)}
					<li class="key-row">
						<div class="key-row__head">
							<Key size={16} />
							<span class="key-row__name">{key.name}</span>
							{#if key.optional}
								<span class="badge">RECOMMENDED</span>
							{:else}
								<span class="badge badge--primary">REQUIRED</span>
							{/if}
						</div>
						<p class="key-row__purpose">{key.purpose}</p>
						<a class="key-row__signup" href={key.signup}>
							<ExternalLink size={14} />
							{key.signupLabel}
						</a>
					</li>
				{/each}
			</ul>
		</section>

		<section class="section">
			<div class="section-heading">
				<div class="eyebrow eyebrow--secondary">STEP 1</div>
				<h2>Create the local manifest</h2>
				<p class="section-lede">
					Download the example manifest, copy it to <code>scoutpost-setup.json</code>, and fill
					it in locally. The filled manifest contains secrets and must not be committed.
				</p>
			</div>
			<div class="actions">
				<a
					class="primary-link"
					href="https://raw.githubusercontent.com/buriedsignals/scoutpost-os/master/deploy/installer/scoutpost-setup.example.json"
				>
					<FileJson size={16} /> Download example manifest
				</a>
				<a
					class="secondary-link"
					href="https://github.com/buriedsignals/scoutpost-os/blob/master/docs/oss/newsroom-docker-install.md"
				>
					<ExternalLink size={16} /> Read Docker install guide
				</a>
			</div>
		</section>

		<section class="section">
			<div class="section-heading">
				<div class="eyebrow eyebrow--secondary">STEP 2</div>
				<h2>Run the installer</h2>
				<p class="section-lede">
					The container clones <code>scoutpost-os</code> if <code>/workspace</code> is not
					already a checkout. The manifest is mounted read-only — secrets never enter the
					image.
				</p>
			</div>
			<SharpCodeBlock code={installCommand} ariaLabel="Copy Docker install command" />
		</section>

		<section class="section">
			<div class="section-heading">
				<div class="eyebrow eyebrow--secondary">STEP 3</div>
				<h2>Validate the deployment</h2>
				<p class="section-lede">
					<code>doctor</code> checks for unresolved conflicts, dirty deploy files, Supabase URL
					drift, and Edge Function readiness. Run it before and after every change.
				</p>
			</div>
			<SharpCodeBlock code={doctorCommand} ariaLabel="Copy Docker doctor command" />
		</section>

		<section class="section">
			<div class="section-heading">
				<div class="eyebrow eyebrow--secondary">MAINTENANCE</div>
				<h2>Prepare update PRs from the same container</h2>
				<p class="section-lede">
					Run updates from a newsroom fork checkout. Mounting GitHub CLI auth lets the installer
					open a reviewable pull request instead of pushing directly.
				</p>
			</div>
			<SharpCodeBlock code={updateCommand} ariaLabel="Copy Docker update command" />
		</section>

		<section class="section">
			<div class="section-heading">
				<div class="eyebrow eyebrow--secondary">BEST PRACTICES</div>
				<h2>Operator rules</h2>
				<p class="section-lede">
					Treat the Docker installer like a CI runner: ephemeral, reproducible, and never
					trusted with secrets that live anywhere but the mounted manifest.
				</p>
			</div>
			<ul class="rules">
				<li><Terminal size={16} /> Run Docker locally; do not paste the manifest into chat.</li>
				<li><LockKeyhole size={16} /> Keep <code>scoutpost-setup.json</code> mode <code>0600</code>.</li>
				<li>
					<Download size={16} /> Pull the published image or build
					<code>deploy/installer/Dockerfile</code> from source.
				</li>
				<li><ShieldCheck size={16} /> Run <code>doctor</code> before and after updates.</li>
			</ul>
		</section>
	</div>
</div>

<style>
	.setup-page {
		min-height: 100vh;
		background: var(--color-bg);
		color: var(--color-ink);
	}

	.content {
		max-width: 1040px;
		margin: 0 auto;
		padding: var(--space-8) var(--space-6) var(--space-16);
	}

	:global(.back-button) {
		margin-bottom: var(--space-12);
	}

	.header {
		max-width: 760px;
		margin-bottom: var(--space-12);
		padding-bottom: var(--space-8);
		border-bottom: 1px solid var(--color-border);
	}

	.header h1 {
		max-width: 780px;
		margin: 0 0 var(--space-6);
		font-family: var(--font-display);
		font-size: 3rem;
		font-weight: 600;
		line-height: 1.05;
		letter-spacing: -0.02em;
	}

	.header p,
	.section-lede,
	.trust-panel span {
		margin: 0;
		color: var(--color-ink-muted);
		font-size: 1rem;
		line-height: 1.65;
	}

	.eyebrow {
		display: inline-block;
		margin-bottom: var(--space-3);
		color: var(--color-ink-muted);
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}

	.eyebrow--secondary {
		color: var(--color-secondary);
	}

	.trust-panel {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: var(--space-4);
		margin-bottom: var(--space-12);
	}

	.trust-panel div {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-5);
		border: 1px solid var(--color-border);
		background: var(--color-surface-alt);
	}

	.trust-panel strong {
		font-family: var(--font-display);
		font-size: 1.0625rem;
		font-weight: 600;
		color: var(--color-ink);
	}

	.section {
		padding: var(--space-12) 0;
		border-top: 1px solid var(--color-border);
	}

	.section:first-of-type {
		border-top: 0;
		padding-top: var(--space-8);
	}

	.section-heading {
		max-width: 760px;
		margin-bottom: var(--space-8);
	}

	.section-heading h2 {
		margin: 0 0 var(--space-4);
		font-family: var(--font-display);
		font-size: 1.75rem;
		font-weight: 600;
		line-height: 1.15;
		letter-spacing: -0.015em;
		color: var(--color-ink);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3);
	}

	.primary-link,
	.secondary-link {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		min-height: 2.75rem;
		padding: 0 var(--space-4);
		border: 1px solid var(--color-ink);
		text-decoration: none;
		font-family: var(--font-mono);
		font-size: 0.75rem;
		font-weight: 500;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		transition: background 150ms ease, color 150ms ease;
	}

	.primary-link {
		background: var(--color-ink);
		color: var(--color-bg);
	}

	.primary-link:hover {
		background: var(--color-primary-deep);
		border-color: var(--color-primary-deep);
	}

	.secondary-link {
		background: var(--color-bg);
		color: var(--color-ink);
	}

	.secondary-link:hover {
		border-color: var(--color-primary);
		color: var(--color-primary);
	}

	code {
		font-family: var(--font-mono);
		font-size: 0.9em;
	}

	.check-list,
	.rules,
	.key-list {
		display: grid;
		gap: var(--space-3);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.check-list li,
	.rules li {
		display: flex;
		align-items: flex-start;
		gap: var(--space-2);
		color: var(--color-ink-muted);
		line-height: 1.55;
	}

	.check-list li :global(svg),
	.rules li :global(svg) {
		flex-shrink: 0;
		margin-top: 0.2em;
		color: var(--color-primary);
	}

	.key-list {
		gap: var(--space-4);
	}

	.key-row {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-5);
		border: 1px solid var(--color-border);
		background: var(--color-surface-alt);
	}

	.key-row__head {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
	}

	.key-row__head :global(svg) {
		color: var(--color-primary);
	}

	.key-row__name {
		font-family: var(--font-display);
		font-size: 1.0625rem;
		font-weight: 600;
		color: var(--color-ink);
	}

	.badge {
		display: inline-flex;
		align-items: center;
		padding: 2px 8px;
		font-family: var(--font-mono);
		font-size: 0.625rem;
		font-weight: 500;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		background: var(--color-secondary-soft);
		color: var(--color-secondary);
		border: 1px solid var(--color-secondary);
	}

	.badge--primary {
		background: var(--color-primary-soft);
		color: var(--color-primary-deep);
		border-color: var(--color-primary);
	}

	.key-row__purpose {
		margin: 0;
		color: var(--color-ink-muted);
		font-size: 0.9375rem;
		line-height: 1.55;
	}

	.key-row__signup {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		align-self: flex-start;
		color: var(--color-primary);
		font-family: var(--font-mono);
		font-size: 0.75rem;
		font-weight: 500;
		letter-spacing: 0.08em;
		text-decoration: none;
	}

	.key-row__signup:hover {
		text-decoration: underline;
		text-underline-offset: 3px;
	}

	.trust-panel div,
	.primary-link,
	.secondary-link,
	.key-row,
	.badge {
		border-radius: var(--radius-lg);
	}

	a:not(.primary-link):not(.secondary-link):not(.key-row__signup) {
		color: var(--color-primary);
		text-underline-offset: 3px;
	}

	@media (max-width: 780px) {
		.content {
			padding: var(--space-6) var(--space-4) var(--space-12);
		}

		.header h1 {
			font-size: 2.35rem;
		}

		.trust-panel {
			grid-template-columns: 1fr;
		}

		.section {
			padding: var(--space-8) 0;
		}

		.primary-link,
		.secondary-link {
			width: 100%;
			justify-content: center;
		}
	}
</style>

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
	import * as m from '$lib/paraglide/messages';
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
			name: m.setup_openRouterKey(),
			purpose:
				m.setup_openRouterPurpose(),
			signup: 'https://openrouter.ai/keys',
			signupLabel: 'openrouter.ai'
		},
		{
			name: m.setup_firecrawlKey(),
			purpose:
				m.setup_firecrawlPurpose(),
			signup: 'https://www.firecrawl.dev/',
			signupLabel: 'firecrawl.dev'
		},
		{
			name: m.setup_apifyToken(),
			purpose: m.setup_apifyPurpose(),
			signup: 'https://console.apify.com/account/integrations',
			signupLabel: 'apify.com'
		},
		{
			name: m.setup_resendKey(),
			purpose: m.setup_resendPurpose(),
			signup: 'https://resend.com/api-keys',
			signupLabel: 'resend.com'
		},
		{
			name: m.setup_mapTilerKey(),
			purpose: m.setup_mapTilerPurpose(),
			signup: 'https://cloud.maptiler.com/account/keys/',
			signupLabel: 'maptiler.com'
		},
		{
			name: m.setup_supabaseToken(),
			purpose: m.setup_supabasePurpose(),
			signup: 'https://supabase.com/dashboard/account/tokens',
			signupLabel: 'supabase.com'
		}
	];
</script>

<svelte:head>
	<title>{m.setup_pageTitle()}</title>
	<meta
		name="description"
		content={m.setup_pageDescription()}
	/>
</svelte:head>

<div class="setup-page">
	<div class="content">
		<SharpAction className="back-button" href="/docs" size="sm" variant="ghost">
			<ArrowLeft class="w-4 h-4" />
			<span>{m.setup_backToDocs()}</span>
		</SharpAction>

		<header class="header">
			<div class="eyebrow">{m.setup_eyebrow()}</div>
			<h1>{m.setup_title()}</h1>
			<p>
				{m.setup_introduction()}
			</p>
		</header>

		<section class="trust-panel" aria-label={m.setup_safetyLabel()}>
			<div>
				<ShieldCheck size={22} />
				<strong>{m.setup_noSecretCollection()}</strong>
				<span
					>{m.setup_localSecretsDescription()}</span
				>
			</div>
			<div>
				<LockKeyhole size={22} />
				<strong>{m.setup_readOnlyMount()}</strong>
				<span>{m.setup_manifestReadBefore()} <code>scoutpost-setup.json</code> {m.setup_manifestReadBetween()} <code>/config</code>.</span>
			</div>
			<div>
				<CheckCircle2 size={22} />
				<strong>{m.setup_repeatableImage()}</strong>
				<span>{m.setup_containerToolsDescription()}</span>
			</div>
		</section>

		<section class="section">
			<div class="section-heading">
				<div class="eyebrow eyebrow--secondary">{m.setup_prerequisitesEyebrow()}</div>
				<h2>{m.setup_prerequisitesTitle()}</h2>
				<p class="section-lede">
					{m.setup_prerequisitesBeforeLink()} <a href="https://www.docker.com/products/docker-desktop/">Docker Desktop</a>
					{m.setup_prerequisitesAfterLink()}
				</p>
			</div>
			<ul class="check-list">
				<li><CheckCircle2 size={16} /> {m.setup_dockerRequirement()}</li>
				<li><CheckCircle2 size={16} /> {m.setup_supabaseRequirement()}</li>
				<li><CheckCircle2 size={16} /> {m.setup_frontendRequirement()}</li>
				<li><CheckCircle2 size={16} /> {m.setup_githubAuthBeforePath()} <code>~/.config/gh</code> {m.setup_githubAuthAfterPath()}</li>
			</ul>
		</section>

		<section class="section">
			<div class="section-heading">
				<div class="eyebrow eyebrow--secondary">{m.setup_accountsEyebrow()}</div>
				<h2>{m.setup_accountsTitle()}</h2>
				<p class="section-lede">
					{m.setup_accountsBeforeManifest()} <code>scoutpost-setup.json</code>
					{m.setup_accountsAfterManifest()}
				</p>
			</div>
			<ul class="key-list">
				{#each requiredKeys as key (key.name)}
					<li class="key-row">
						<div class="key-row__head">
							<Key size={16} />
							<span class="key-row__name">{key.name}</span>
							{#if key.optional}
								<span class="badge">{m.civic_recommended()}</span>
							{:else}
								<span class="badge badge--primary">{m.setup_required()}</span>
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
				<div class="eyebrow eyebrow--secondary">{m.setup_step({ number: 1 })}</div>
				<h2>{m.setup_manifestTitle()}</h2>
				<p class="section-lede">
					{m.setup_manifestBeforeFilename()} <code>scoutpost-setup.json</code>{m.setup_manifestAfterFilename()}
				</p>
			</div>
			<div class="actions">
				<a
					class="primary-link"
					href="https://raw.githubusercontent.com/buriedsignals/scoutpost-os/master/deploy/installer/scoutpost-setup.example.json"
				>
					<FileJson size={16} /> {m.setup_downloadManifest()}
				</a>
				<a
					class="secondary-link"
					href="https://github.com/buriedsignals/scoutpost-os/blob/master/docs/oss/newsroom-docker-install.md"
				>
					<ExternalLink size={16} /> {m.setup_installGuide()}
				</a>
			</div>
		</section>

		<section class="section">
			<div class="section-heading">
				<div class="eyebrow eyebrow--secondary">{m.setup_step({ number: 2 })}</div>
				<h2>{m.setup_installTitle()}</h2>
				<p class="section-lede">
					{m.setup_installBeforeRepository()} <code>scoutpost-os</code> {m.setup_installBetweenPaths()} <code>/workspace</code>
					{m.setup_installAfterWorkspace()}
				</p>
			</div>
			<SharpCodeBlock code={installCommand} ariaLabel={m.setup_copyInstallCommand()} />
		</section>

		<section class="section">
			<div class="section-heading">
				<div class="eyebrow eyebrow--secondary">{m.setup_step({ number: 3 })}</div>
				<h2>{m.setup_validateTitle()}</h2>
				<p class="section-lede">
					<code>doctor</code> {m.setup_doctorDescription()}
				</p>
			</div>
			<SharpCodeBlock code={doctorCommand} ariaLabel={m.setup_copyDoctorCommand()} />
		</section>

		<section class="section">
			<div class="section-heading">
				<div class="eyebrow eyebrow--secondary">{m.setup_maintenanceEyebrow()}</div>
				<h2>{m.setup_maintenanceTitle()}</h2>
				<p class="section-lede">
					{m.setup_maintenanceDescription()}
				</p>
			</div>
			<SharpCodeBlock code={updateCommand} ariaLabel={m.setup_copyUpdateCommand()} />
		</section>

		<section class="section">
			<div class="section-heading">
				<div class="eyebrow eyebrow--secondary">{m.setup_bestPracticesEyebrow()}</div>
				<h2>{m.setup_rulesTitle()}</h2>
				<p class="section-lede">
					{m.setup_rulesDescription()}
				</p>
			</div>
			<ul class="rules">
				<li><Terminal size={16} /> {m.setup_runLocallyRule()}</li>
				<li><LockKeyhole size={16} /> {m.setup_permissionsBeforeManifest()} <code>scoutpost-setup.json</code> {m.setup_permissionsBeforeMode()} <code>0600</code>.</li>
				<li>
					<Download size={16} /> {m.setup_imageBeforeDockerfile()}
					<code>deploy/installer/Dockerfile</code> {m.setup_imageAfterDockerfile()}
				</li>
				<li><ShieldCheck size={16} /> {m.setup_doctorRuleBeforeCommand()} <code>doctor</code> {m.setup_doctorRuleAfterCommand()}</li>
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

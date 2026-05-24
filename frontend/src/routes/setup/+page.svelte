<script lang="ts">
	import {
		ArrowLeft,
		CheckCircle2,
		Download,
		ExternalLink,
		FileJson,
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
				<span>API keys, service-role keys, JWT secrets, and deploy hooks stay in a local file.</span>
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
				<div class="eyebrow">STEP 1</div>
				<h2>Create the local manifest</h2>
			</div>
			<p>
				Download the example manifest, copy it to <code>scoutpost-setup.json</code>, and fill it
				in locally. The filled manifest contains secrets and must not be committed.
			</p>
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
				<div class="eyebrow">STEP 2</div>
				<h2>Run the installer</h2>
			</div>
			<SharpCodeBlock code={installCommand} ariaLabel="Copy Docker install command" />
		</section>

		<section class="section">
			<div class="section-heading">
				<div class="eyebrow">STEP 3</div>
				<h2>Validate the deployment</h2>
			</div>
			<SharpCodeBlock code={doctorCommand} ariaLabel="Copy Docker doctor command" />
		</section>

		<section class="section">
			<div class="section-heading">
				<div class="eyebrow">MAINTENANCE</div>
				<h2>Prepare update PRs from the same container</h2>
			</div>
			<p>
				Run updates from a newsroom fork checkout. Mounting GitHub CLI auth lets the installer
				open a reviewable pull request instead of pushing directly.
			</p>
			<SharpCodeBlock code={updateCommand} ariaLabel="Copy Docker update command" />
		</section>

		<section class="section">
			<div class="section-heading">
				<div class="eyebrow">BEST PRACTICES</div>
				<h2>Operator rules</h2>
			</div>
			<ul class="rules">
				<li><Terminal size={16} /> Run Docker locally; do not paste the manifest into chat.</li>
				<li><LockKeyhole size={16} /> Keep <code>scoutpost-setup.json</code> mode <code>0600</code>.</li>
				<li><Download size={16} /> Pull the published image or build <code>deploy/installer/Dockerfile</code> from source.</li>
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
		margin-bottom: var(--space-8);
	}

	.header h1 {
		max-width: 780px;
		margin: 0 0 var(--space-5);
		font-family: var(--font-display);
		font-size: 3rem;
		font-weight: 600;
		line-height: 1;
	}

	.header p,
	.section p,
	.trust-panel span {
		margin: 0;
		color: var(--color-ink-muted);
		line-height: 1.65;
	}

	.eyebrow {
		margin-bottom: var(--space-2);
		color: var(--color-secondary);
		font-family: var(--font-mono);
		font-size: 0.7rem;
		font-weight: 500;
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}

	.trust-panel {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: var(--space-4);
		margin-bottom: var(--space-10);
	}

	.trust-panel div {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-5);
		border: 1px solid var(--color-border);
		background: var(--color-surface-alt);
	}

	.section {
		padding: var(--space-7) 0;
		border-top: 1px solid var(--color-border);
	}

	.section-heading {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		margin-bottom: var(--space-5);
	}

	.section h2 {
		margin: 0;
		font-family: var(--font-display);
		font-size: 1.75rem;
		font-weight: 600;
		line-height: 1.15;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3);
		margin-top: var(--space-5);
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
		font-weight: 700;
	}

	.primary-link {
		background: var(--color-ink);
		color: var(--color-bg);
	}

	.secondary-link {
		background: var(--color-bg);
		color: var(--color-ink);
	}

	code {
		font-family: var(--font-mono);
		font-size: 0.9em;
	}

	.rules {
		display: grid;
		gap: var(--space-3);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.rules li {
		display: flex;
		align-items: flex-start;
		gap: var(--space-2);
		color: var(--color-ink-muted);
		line-height: 1.55;
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

		.primary-link,
		.secondary-link {
			width: 100%;
			justify-content: center;
		}
	}
</style>

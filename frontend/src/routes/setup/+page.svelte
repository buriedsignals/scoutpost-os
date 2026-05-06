<script lang="ts">
	import {
		ArrowLeft,
		Bot,
		Download,
		ExternalLink,
		FileJson,
		FileText,
		Package,
		Mail,
		Map,
		RefreshCw,
		Server,
		Terminal
	} from 'lucide-svelte';
	import { tick } from 'svelte';
	import SharpAction from '$lib/components/docs/SharpAction.svelte';
	import SharpCodeBlock from '$lib/components/docs/SharpCodeBlock.svelte';
	import {
		buildAgentManifestPrompt,
		buildDockerInstallerInstructions,
		buildInstallScript,
		buildNewsroomOnboarding,
		normalizeDomains,
		redactSetupManifest,
		validateSetupManifest,
		type FrontendProvider,
		type SetupManifest,
		type SupabaseMode
	} from '$lib/setup/setup-generator';

	let projectName = 'cojournalist-newsroom';
	let appUrl = '';
	let geminiKey = '';
	let firecrawlKey = '';
	let apifyToken = '';
	let resendKey = '';
	let resendFromEmail = 'scouts@newsroom.example.com';
	let maptilerKey = '';
	let adminEmail = '';
	let signupDomainsText = '';
	let supabaseMode: SupabaseMode = 'cloud-create';
	let supabaseProjectRef = '';
	let supabaseProjectUrl = '';
	let supabaseAnonKey = '';
	let supabaseServiceKey = '';
	let supabaseJwtSecret = '';
	let supabaseOrgId = '';
	let supabaseRegion = 'us-east-1';
	let supabaseDbPassword = '';
	let selfHostedPostgresPassword = '';
	let frontendProvider: FrontendProvider = 'netlify';
	let frontendSiteName = 'cojournalist-newsroom';
	let customMcpUrl = '';
	let includeFastapiAddon = false;
	let installSyncWorkflow = true;
	let renderDeployHook = '';
	let generated = false;

	$: signupDomains = normalizeDomains(signupDomainsText);
	$: manifest = buildManifest();
	$: validation = validateSetupManifest(manifest);
	$: redactedManifest = JSON.stringify(redactSetupManifest(manifest), null, 2);
	$: installScript = buildInstallScript(manifest);
	$: dockerInstructions = buildDockerInstallerInstructions();
	$: agentPrompt = buildAgentManifestPrompt('./cojournalist-setup.json');
	$: agentPromptFile = `${agentPrompt}

Expected local files:
- ./cojournalist-setup.json
- automation/setup-from-manifest.sh in the coJournalist repository

Run the manifest installer from the repository root. Never ask the operator to paste API keys, JWT secrets, service role keys, or deploy hooks into chat.`;
	$: onboardingDoc = buildNewsroomOnboarding(manifest);

	const costItems = [
		{ service: 'Supabase', estimate: '$25', note: 'Pro project for Auth, Postgres, Edge Functions' },
		{ service: 'Firecrawl', estimate: '$83-$99', note: 'Standard subscription, annual vs monthly billing' },
		{ service: 'Apify', estimate: '$29', note: 'Starter subscription for social source collection' },
		{ service: 'Gemini', estimate: '$1-$10', note: 'Moderate Flash-Lite usage for extraction and summaries' },
		{ service: 'Resend', estimate: '$0', note: 'Free plan can cover one verified domain at lower volume' },
		{ service: 'MapTiler', estimate: '$0', note: 'Free plan is enough to start for maps and geocoding' },
		{ service: 'Hosting', estimate: '$0-$25', note: 'Static frontend on selected provider' }
	];

	const supabaseRegions = [
		{ value: 'us-east-1', label: 'US East - North Virginia (us-east-1)' },
		{ value: 'us-west-1', label: 'US West - North California (us-west-1)' },
		{ value: 'us-west-2', label: 'US West - Oregon (us-west-2)' },
		{ value: 'ca-central-1', label: 'Canada - Central (ca-central-1)' },
		{ value: 'eu-west-1', label: 'EU West - Ireland (eu-west-1)' },
		{ value: 'eu-west-2', label: 'EU West - London (eu-west-2)' },
		{ value: 'eu-west-3', label: 'EU West - Paris (eu-west-3)' },
		{ value: 'eu-central-1', label: 'EU Central - Frankfurt (eu-central-1)' },
		{ value: 'eu-north-1', label: 'EU North - Stockholm (eu-north-1)' },
		{ value: 'ap-south-1', label: 'Asia Pacific - Mumbai (ap-south-1)' },
		{ value: 'ap-southeast-1', label: 'Asia Pacific - Singapore (ap-southeast-1)' },
		{ value: 'ap-southeast-2', label: 'Asia Pacific - Sydney (ap-southeast-2)' },
		{ value: 'ap-northeast-1', label: 'Asia Pacific - Tokyo (ap-northeast-1)' },
		{ value: 'ap-northeast-2', label: 'Asia Pacific - Seoul (ap-northeast-2)' },
		{ value: 'sa-east-1', label: 'South America - Sao Paulo (sa-east-1)' }
	];

	function buildManifest(): SetupManifest {
		const cleanAppUrl = appUrl.trim().replace(/\/$/, '');
		return {
			version: 1,
			project: {
				name: projectName.trim(),
				app_url: cleanAppUrl
			},
			services: {
				gemini_api_key: geminiKey.trim(),
				firecrawl_api_key: firecrawlKey.trim(),
				apify_api_token: apifyToken.trim(),
				resend_api_key: resendKey.trim(),
				resend_from_email: resendFromEmail.trim(),
				public_maptiler_api_key: maptilerKey.trim()
			},
			auth: {
				admin_email: adminEmail.trim(),
				signup_allowed_domains: signupDomains
			},
			supabase: {
				mode: supabaseMode,
				project_ref: supabaseProjectRef.trim() || undefined,
				project_url: supabaseProjectUrl.trim().replace(/\/$/, '') || undefined,
				anon_key: supabaseAnonKey.trim() || undefined,
				service_role_key: supabaseServiceKey.trim() || undefined,
				jwt_secret: supabaseJwtSecret.trim() || undefined,
				org_id: supabaseOrgId.trim() || undefined,
				region: supabaseRegion.trim() || undefined,
				db_password: supabaseDbPassword || undefined,
				self_hosted_postgres_password: selfHostedPostgresPassword || undefined
			},
			frontend: {
				provider: frontendProvider,
				site_name: frontendSiteName.trim() || undefined,
				production_url: cleanAppUrl
			},
			agents: {
				custom_mcp_url: customMcpUrl.trim().replace(/\/$/, '') || undefined,
				install_firecrawl_skill: true,
				install_supabase_skill: true,
				install_render_skill: frontendProvider === 'render'
			},
			options: {
				include_fastapi_addon: includeFastapiAddon,
				install_sync_workflow: installSyncWorkflow,
				render_deploy_hook: renderDeployHook.trim() || undefined
			}
		};
	}

	async function validateBeforeDownload() {
		generated = true;
		await tick();
		if (!validation.valid) {
			document.querySelector('.validation-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
			return false;
		}
		return true;
	}

	async function downloadInstaller() {
		if (!(await validateBeforeDownload())) return;
		download('cojournalist-install.sh', installScript, 'text/x-shellscript');
	}

	async function downloadAgentInstructions() {
		if (!(await validateBeforeDownload())) return;
		download('cojournalist-setup.json', JSON.stringify(manifest, null, 2), 'application/json');
		window.setTimeout(() => {
			download('cojournalist-agent-prompt.md', agentPromptFile, 'text/markdown');
		}, 150);
	}

	async function downloadDockerInstaller() {
		if (!(await validateBeforeDownload())) return;
		download('cojournalist-setup.json', JSON.stringify(manifest, null, 2), 'application/json');
		window.setTimeout(() => {
			download('cojournalist-docker-install.md', dockerInstructions, 'text/markdown');
		}, 150);
	}

	async function downloadOnboarding() {
		if (!(await validateBeforeDownload())) return;
		download('newsroom-onboarding.md', onboardingDoc, 'text/markdown');
	}

	function generateDatabasePassword() {
		const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_.~';
		const values = new Uint32Array(28);
		crypto.getRandomValues(values);
		supabaseDbPassword = Array.from(values, (value) => chars[value % chars.length]).join('');
	}

	function download(filename: string, contents: string, type: string) {
		const blob = new Blob([contents], { type });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}
</script>

<svelte:head>
	<title>Self-host setup - coJournalist</title>
	<meta
		name="description"
		content="Generate a self-hosted coJournalist installer without pasting secrets into AI chat."
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
			<h1>Generate your newsroom installer</h1>
			<p>
				Fill this out locally in your browser. Docker is the recommended install path: the
				generated manifest stays on disk, mounts read-only into the operator container, and is reused
				for validation and downstream update PRs.
			</p>
		</header>

		<section class="cost-panel" aria-labelledby="cost-title">
			<div>
				<div class="eyebrow">20-PERSON NEWSROOM ESTIMATE</div>
				<h2 id="cost-title">$140-$165/month typical</h2>
				<p>
					Assumes managed Supabase, Firecrawl Standard, Apify Starter, free Resend, free MapTiler,
					one static frontend, and moderate Gemini Flash-Lite usage. Heavy scout volume may raise
					usage later, but the setup baseline is mostly fixed subscriptions.
				</p>
			</div>
			<div class="cost-list">
				{#each costItems as item}
					<div>
						<strong>{item.service}</strong>
						<span>{item.estimate}</span>
						<small>{item.note}</small>
					</div>
				{/each}
			</div>
		</section>

		<form class="setup-form" on:submit|preventDefault={downloadInstaller}>
			<section class="section">
				<div class="section-heading">
					<div class="eyebrow">PROJECT</div>
					<h2>Newsroom identity</h2>
				</div>
				<div class="grid two">
					<label>
						<span>Project name</span>
						<input bind:value={projectName} />
						<small>Used for Supabase, hosting defaults, and local generated files.</small>
					</label>
					<label>
						<span>Public app URL <em>optional for first setup</em></span>
						<input bind:value={appUrl} placeholder="https://newsroom.example.com" />
						<small>
							Not required to provision. Add it after hosting if you want onboarding links prefilled.
						</small>
					</label>
				</div>
			</section>

			<section class="section">
				<div class="section-heading">
					<div class="eyebrow">SERVICE KEYS</div>
					<h2>AI, extraction, email, and maps</h2>
				</div>

				<div class="service-category">
					<h3><Bot size={17} /> AI model</h3>
					<div class="grid two">
						<label>
							<span class="field-top">
								<span>Gemini API key</span>
								<a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer">
									Get key <ExternalLink size={13} />
								</a>
							</span>
							<input type="password" bind:value={geminiKey} autocomplete="off" />
							<small>Runs relevance checks, summaries, unit extraction, and embeddings.</small>
						</label>
					</div>
				</div>

				<div class="service-category">
					<h3><Server size={17} /> Web and social collection</h3>
					<div class="grid two">
						<label>
							<span class="field-top">
								<span>Firecrawl API key</span>
								<a href="https://www.firecrawl.dev/app/api-keys" target="_blank" rel="noopener noreferrer">
									Get key <ExternalLink size={13} />
								</a>
							</span>
							<input type="password" bind:value={firecrawlKey} autocomplete="off" />
							<small>Scrapes pages, tracks changes, searches the web, and parses documents.</small>
						</label>
						<label>
							<span class="field-top">
								<span>Apify API token</span>
								<a href="https://console.apify.com/account/integrations" target="_blank" rel="noopener noreferrer">
									Get token <ExternalLink size={13} />
								</a>
							</span>
							<input type="password" bind:value={apifyToken} autocomplete="off" />
							<small>Runs social media actors for Social Scouts.</small>
						</label>
					</div>
				</div>

				<div class="service-category">
					<h3><Mail size={17} /> Email notifications</h3>
					<div class="grid two">
						<label>
							<span class="field-top">
								<span>Resend API key</span>
								<a href="https://resend.com/api-keys" target="_blank" rel="noopener noreferrer">
									Get key <ExternalLink size={13} />
								</a>
							</span>
							<input type="password" bind:value={resendKey} autocomplete="off" />
							<small>Sends scout alerts, onboarding messages, and admin notifications.</small>
						</label>
						<label>
							<span>Resend sender email</span>
							<input bind:value={resendFromEmail} />
							<small>Use a verified sender on your newsroom domain.</small>
						</label>
					</div>
				</div>

				<div class="service-category">
					<h3><Map size={17} /> Location and maps</h3>
					<div class="grid two">
						<label>
							<span class="field-top">
								<span>MapTiler API key</span>
								<a href="https://cloud.maptiler.com/account/keys/" target="_blank" rel="noopener noreferrer">
									Get key <ExternalLink size={13} />
								</a>
							</span>
							<input type="password" bind:value={maptilerKey} autocomplete="off" />
							<small>Required for location scouting, geocoding, and map search.</small>
						</label>
					</div>
				</div>
			</section>

			<section class="section">
				<div class="section-heading">
					<div class="eyebrow">SIGNUP CONTROLS</div>
					<h2>Admin and allowed domains</h2>
				</div>
				<div class="grid auth-grid">
					<label>
						<span>Admin email</span>
						<input bind:value={adminEmail} placeholder="it-admin@example.com" />
						<small>Seeded as the deployment owner and support contact.</small>
					</label>
					<label>
						<span>Allowed signup domains</span>
						<textarea bind:value={signupDomainsText} placeholder="example.com&#10;newsroom.org"></textarea>
						<small>One per line or comma-separated. The Supabase auth hook rejects other domains.</small>
					</label>
				</div>
			</section>

			<section class="section">
				<div class="section-heading">
					<div class="eyebrow">SUPABASE</div>
					<h2>Database, auth, and Edge Functions</h2>
				</div>
				<div class="choice-row">
					<label><input type="radio" bind:group={supabaseMode} value="cloud-create" /> Create cloud project</label>
					<label><input type="radio" bind:group={supabaseMode} value="cloud-existing" /> Existing cloud project</label>
					<label><input type="radio" bind:group={supabaseMode} value="self-hosted" /> Self-hosted</label>
					<a href="https://supabase.com/dashboard" target="_blank" rel="noopener noreferrer">
						Supabase dashboard <ExternalLink size={13} />
					</a>
				</div>

				{#if supabaseMode === 'cloud-create'}
					<div class="grid three">
						<label><span>Organization ID</span><input bind:value={supabaseOrgId} /></label>
						<label>
							<span>Region</span>
							<select bind:value={supabaseRegion}>
								{#each supabaseRegions as region}
									<option value={region.value}>{region.label}</option>
								{/each}
							</select>
						</label>
						<label>
							<span class="field-top">
								<span>Database password</span>
								<button type="button" class="inline-action" on:click={generateDatabasePassword}>
									<RefreshCw size={13} /> Generate
								</button>
							</span>
							<input type="password" bind:value={supabaseDbPassword} autocomplete="off" />
							<small>
								The installer uses Supabase CLI auth, but project creation still requires a
								database password. Save it in your password manager.
							</small>
						</label>
					</div>
					<div class="setup-note">
						<strong>Supabase CLI login:</strong>
						the installer will use `supabase login` if your CLI is not already authenticated.
						<a href="https://supabase.com/docs/guides/cli" target="_blank" rel="noopener noreferrer">
							Install CLI <ExternalLink size={13} />
						</a>
						<a href="https://supabase.com/dashboard/project/_/settings/database" target="_blank" rel="noopener noreferrer">
							Database settings <ExternalLink size={13} />
						</a>
					</div>
				{:else}
					<div class="grid two">
						{#if supabaseMode === 'cloud-existing'}
							<label><span>Project ref</span><input bind:value={supabaseProjectRef} /></label>
						{/if}
						<label><span>Supabase URL</span><input bind:value={supabaseProjectUrl} /></label>
						<label><span>Anon key</span><input type="password" bind:value={supabaseAnonKey} autocomplete="off" /></label>
						<label><span>Service role key</span><input type="password" bind:value={supabaseServiceKey} autocomplete="off" /></label>
						<label><span>JWT secret</span><input type="password" bind:value={supabaseJwtSecret} autocomplete="off" /></label>
						{#if supabaseMode === 'self-hosted'}
							<label><span>Postgres password</span><input type="password" bind:value={selfHostedPostgresPassword} autocomplete="off" /></label>
						{/if}
					</div>
				{/if}
			</section>

			<section class="section">
				<div class="section-heading">
					<div class="eyebrow">FRONTEND HOSTING</div>
					<h2>Static app deployment</h2>
				</div>
				<div class="choice-row">
					<label><input type="radio" bind:group={frontendProvider} value="netlify" /> Netlify</label>
					<label><input type="radio" bind:group={frontendProvider} value="vercel" /> Vercel</label>
					<label><input type="radio" bind:group={frontendProvider} value="cloudflare" /> Cloudflare Pages</label>
					<label><input type="radio" bind:group={frontendProvider} value="render" /> Render</label>
					<label><input type="radio" bind:group={frontendProvider} value="manual" /> Manual</label>
				</div>
				<div class="grid two">
					<label><span>Site/project name</span><input bind:value={frontendSiteName} /></label>
					<label>
						<span>Custom MCP public URL <em>optional</em></span>
						<input bind:value={customMcpUrl} placeholder="https://mcp.newsroom.example.com" />
					</label>
				</div>
				<details class="advanced-options">
					<summary>Advanced deployment options</summary>
					<div class="choice-row options">
						<label>
							<input type="checkbox" bind:checked={installSyncWorkflow} />
							<span>
								Keep this fork updated from coJournalist OSS
								<small>
									Adds a weekly GitHub workflow that merges upstream code. For automatic Supabase
									migrations, add a GitHub secret named SUPABASE_ACCESS_TOKEN.
								</small>
							</span>
						</label>
						<label>
							<input type="checkbox" bind:checked={includeFastapiAddon} />
							<span>
								Legacy REST API add-on
								<small>Only needed if you require the older `/api/v1` FastAPI surface.</small>
							</span>
						</label>
					</div>
					<label class="single">
						<span>Render deploy hook <em>optional</em></span>
						<input bind:value={renderDeployHook} />
						<small>Used only if Render should redeploy automatically after upstream syncs.</small>
					</label>
				</details>
			</section>

			<section class="section generate-section">
				<div class="section-heading">
					<div class="eyebrow">GENERATE</div>
					<h2>Choose one setup path</h2>
				</div>

				{#if generated && !validation.valid}
					<div class="validation-panel" role="alert">
						<strong>Fix these fields:</strong>
						<ul>
							{#each validation.errors as error}
								<li>{error}</li>
							{/each}
						</ul>
					</div>
				{/if}

				<div class="output-options">
					<div class="option recommended">
						<Package class="option-icon" size={22} />
						<h3>Docker installer</h3>
						<p>Recommended. Download the credentials manifest plus Docker commands for install, doctor, and downstream update PRs.</p>
						<button type="button" class="primary-button" on:click={downloadDockerInstaller}>
							<Download size={16} /> Download Docker files
						</button>
					</div>
					<div class="option">
						<FileJson class="option-icon" size={22} />
						<h3>Generate agent instructions</h3>
						<p>Download `cojournalist-setup.json` plus a prompt that tells the agent to prefer Docker and read the local manifest.</p>
						<button type="button" class="primary-button" on:click={downloadAgentInstructions}>
							<FileText size={16} /> Download JSON + prompt
						</button>
					</div>
					<div class="option">
						<Terminal class="option-icon" size={22} />
						<h3>Shell fallback</h3>
						<p>Download a runnable shell script with the same manifest embedded for environments where Docker is unavailable.</p>
						<button type="button" class="primary-button" on:click={downloadInstaller}>
							<Download size={16} /> Download .sh
						</button>
					</div>
				</div>

				<button type="button" class="secondary-button" on:click={downloadOnboarding}>
					<FileText size={16} /> Download newsroom onboarding doc
				</button>
			</section>
		</form>

		{#if generated && validation.valid}
			<section class="preview">
				<h2>Agent prompt preview</h2>
				<SharpCodeBlock code={agentPromptFile} ariaLabel="Copy agent manifest prompt" />
				<h2>Redacted manifest preview</h2>
				<SharpCodeBlock code={redactedManifest} ariaLabel="Copy redacted manifest" />
			</section>
		{/if}
	</div>
</div>

<style>
	.setup-page {
		min-height: 100vh;
		background: var(--color-bg);
		color: var(--color-ink);
	}

	.content {
		max-width: 1120px;
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
	.cost-panel p,
	.option p {
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

	.cost-panel {
		display: grid;
		grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
		gap: var(--space-8);
		margin-bottom: var(--space-8);
		padding: var(--space-6);
		border: 1px solid var(--color-border-strong);
		background: var(--color-surface-alt);
	}

	.cost-panel h2 {
		margin: 0 0 var(--space-3);
		font-family: var(--font-display);
		font-size: 2rem;
		font-weight: 600;
		line-height: 1.05;
	}

	.cost-list {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0;
		border-top: 1px solid var(--color-border);
		border-left: 1px solid var(--color-border);
	}

	.cost-list div {
		display: grid;
		grid-template-columns: 1fr auto;
		gap: var(--space-1) var(--space-3);
		padding: var(--space-3);
		border-right: 1px solid var(--color-border);
		border-bottom: 1px solid var(--color-border);
		background: var(--color-bg);
		min-width: 0;
	}

	.cost-list strong,
	.cost-list span {
		font-size: 0.9rem;
	}

	.cost-list small {
		grid-column: 1 / -1;
		color: var(--color-ink-muted);
		line-height: 1.45;
	}

	.setup-form,
	.preview {
		display: flex;
		flex-direction: column;
		gap: var(--space-8);
	}

	.section {
		padding-top: var(--space-6);
		border-top: 1px solid var(--color-border);
	}

	.section-heading {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		margin-bottom: var(--space-5);
	}

	.section h2,
	.preview h2 {
		margin: 0;
		font-family: var(--font-display);
		font-size: 1.75rem;
		font-weight: 600;
		line-height: 1.15;
	}

	.service-category {
		margin-top: var(--space-6);
	}

	.service-category:first-of-type {
		margin-top: 0;
	}

	.service-category h3,
	.option h3 {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin: 0 0 var(--space-4);
		font-size: 0.95rem;
		font-weight: 700;
	}

	.grid {
		display: grid;
		gap: var(--space-4);
	}

	.two {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}

	.three {
		grid-template-columns: repeat(3, minmax(0, 1fr));
	}

	.auth-grid {
		grid-template-columns: minmax(260px, 0.8fr) minmax(320px, 1.2fr);
		align-items: start;
	}

	label,
	.single {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		font-size: 0.86rem;
		font-weight: 650;
		min-width: 0;
	}

	label em {
		color: var(--color-ink-muted);
		font-style: normal;
		font-weight: 500;
	}

	label small {
		color: var(--color-ink-muted);
		font-size: 0.78rem;
		font-weight: 400;
		line-height: 1.45;
	}

	.field-top {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		align-items: center;
		justify-content: space-between;
	}

	a,
	.field-top a,
	.choice-row a {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		color: var(--color-primary);
		font-size: 0.78rem;
		font-weight: 650;
		text-decoration: none;
	}

	a:hover {
		color: var(--color-primary-deep);
		text-decoration: underline;
	}

	input,
	select,
	textarea {
		width: 100%;
		min-width: 0;
		border: 1px solid var(--color-border);
		border-radius: 0;
		background: var(--color-surface-alt);
		color: var(--color-ink);
		padding: 0.78rem 0.85rem;
		font: inherit;
		font-weight: 400;
	}

	textarea {
		min-height: 7rem;
		resize: vertical;
	}

	input:focus,
	select:focus,
	textarea:focus {
		outline: 2px solid var(--color-primary);
		outline-offset: 2px;
		border-color: var(--color-primary);
	}

	.choice-row {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		align-items: center;
		margin: 0 0 var(--space-5);
	}

	.choice-row label {
		flex-direction: row;
		align-items: flex-start;
		gap: var(--space-2);
		font-weight: 600;
	}

	.choice-row:not(.options) label {
		align-items: center;
		min-height: 2.5rem;
		padding: 0.6rem 0.8rem;
		border: 1px solid var(--color-border);
		background: var(--color-surface-alt);
		line-height: 1.1;
		cursor: pointer;
		transition:
			background 150ms ease,
			border-color 150ms ease,
			color 150ms ease;
	}

	.choice-row:not(.options) label:hover {
		border-color: var(--color-border-strong);
		color: var(--color-primary-deep);
	}

	.choice-row:not(.options) label:has(input:checked) {
		border-color: var(--color-primary);
		background: var(--color-primary-soft);
		color: var(--color-primary-deep);
	}

	.choice-row label span {
		display: grid;
		gap: var(--space-1);
	}

	.choice-row input {
		width: auto;
	}

	.choice-row input[type='radio'],
	.choice-row input[type='checkbox'] {
		flex: 0 0 auto;
		width: 0.82rem;
		height: 0.82rem;
		margin: 0;
	}

	.choice-row:not(.options) input[type='radio'] {
		appearance: none;
		display: grid;
		place-items: center;
		border: 1px solid var(--color-border-strong);
		border-radius: 0;
		background: var(--color-bg);
	}

	.choice-row:not(.options) input[type='radio']::before {
		content: '';
		width: 0.34rem;
		height: 0.34rem;
		background: transparent;
	}

	.choice-row:not(.options) input[type='radio']:checked {
		border-color: var(--color-primary);
		background: var(--color-primary);
	}

	.choice-row:not(.options) input[type='radio']:checked::before {
		background: var(--color-bg);
	}

	.options {
		margin-top: var(--space-4);
	}

	.setup-note,
	.advanced-options {
		margin-top: var(--space-4);
		padding: var(--space-4);
		border: 1px solid var(--color-border);
		background: var(--color-surface-alt);
		color: var(--color-ink-muted);
		font-size: 0.84rem;
		line-height: 1.55;
	}

	.setup-note {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2) var(--space-4);
		align-items: center;
	}

	.setup-note strong {
		color: var(--color-ink);
	}

	.advanced-options summary {
		color: var(--color-ink);
		font-weight: 750;
		cursor: pointer;
	}

	.advanced-options .single {
		margin-top: var(--space-4);
	}

	.generate-section {
		padding-bottom: var(--space-8);
	}

	.validation-panel {
		margin-bottom: var(--space-5);
		padding: var(--space-4);
		border: 1px solid var(--color-warning);
		background: var(--color-secondary-soft);
	}

	.validation-panel ul {
		margin: var(--space-2) 0 0;
		padding-left: var(--space-5);
	}

	.output-options {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: var(--space-4);
	}

	.option {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--space-3);
		padding: var(--space-5);
		border: 1px solid var(--color-border-strong);
		background: var(--color-surface-alt);
	}

	.option.recommended {
		border-color: var(--color-primary);
		box-shadow: inset 0 3px 0 var(--color-primary);
	}

	:global(.option-icon) {
		color: var(--color-primary);
	}

	button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-2);
		border: 1px solid var(--color-ink);
		border-radius: 0;
		padding: 0.78rem 1rem;
		font: inherit;
		font-size: 0.83rem;
		font-weight: 750;
		cursor: pointer;
		transition:
			background 150ms ease,
			color 150ms ease,
			border-color 150ms ease;
	}

	.inline-action {
		border: 0;
		background: transparent;
		color: var(--color-primary);
		padding: 0;
		font-size: 0.78rem;
		font-weight: 700;
	}

	.inline-action:hover {
		color: var(--color-primary-deep);
	}

	button:focus {
		outline: 2px solid var(--color-primary);
		outline-offset: 2px;
	}

	.primary-button {
		background: var(--color-ink);
		color: var(--color-bg);
	}

	.primary-button:hover {
		background: var(--color-primary-deep);
		border-color: var(--color-primary-deep);
	}

	.secondary-button {
		margin-top: var(--space-4);
		background: var(--color-surface-alt);
		color: var(--color-ink);
	}

	.secondary-button:hover {
		border-color: var(--color-primary);
		color: var(--color-primary-deep);
	}

	.preview {
		padding-top: var(--space-6);
		border-top: 1px solid var(--color-border);
	}

	@media (max-width: 900px) {
		.cost-panel,
		.two,
		.three,
		.auth-grid,
		.output-options {
			grid-template-columns: 1fr;
		}

		.header h1 {
			max-width: 100%;
			font-size: 2.65rem;
		}

		.cost-list {
			grid-template-columns: 1fr;
		}
	}

	@media (max-width: 560px) {
		.content {
			padding: var(--space-6) var(--space-4) var(--space-12);
		}

		.cost-panel,
		.option {
			padding: var(--space-4);
		}
	}
</style>

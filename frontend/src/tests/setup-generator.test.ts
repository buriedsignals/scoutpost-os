import { describe, expect, it } from 'vitest';
import {
	buildAgentManifestPrompt,
	buildDockerInstallerInstructions,
	buildDockerInstallerScript,
	buildInstallScript,
	buildNewsroomOnboarding,
	buildProviderPortingPacket,
	deriveAgentTargetFromManifest,
	normalizeDomains,
	redactSetupManifest,
	shellEscape,
	validateSetupManifest,
	type SetupManifest
} from '$lib/setup/setup-generator';

function manifest(overrides: Partial<SetupManifest> = {}): SetupManifest {
	const base: SetupManifest = {
		version: 1,
		project: { name: 'test-newsroom', app_url: 'https://newsroom.example.com' },
		services: {
			gemini_api_key: 'gemini-secret',
			firecrawl_api_key: 'firecrawl-secret',
			exa_api_key: 'exa-secret',
			apify_api_token: 'apify-secret',
			resend_api_key: 'resend-secret',
			resend_from_email: 'scouts@example.com',
			public_maptiler_api_key: 'maptiler-secret'
		},
		auth: {
			admin_email: 'admin@example.com',
			signup_allowed_domains: ['example.com']
		},
		data_platform: {
			provider: 'supabase',
			provider_name: 'Supabase',
			integration_mode: 'managed'
		},
		supabase: {
			mode: 'cloud-existing',
			project_ref: 'newsroomref',
			project_url: 'https://newsroomref.supabase.co',
			anon_key: 'anon-secret',
			service_role_key: 'service-secret',
			jwt_secret: 'jwt-secret',
			access_token: 'sbp-secret'
		},
		frontend: {
			provider: 'netlify',
			site_name: 'test-newsroom',
			production_url: 'https://newsroom.example.com'
		},
		agents: {
			install_firecrawl_skill: true,
			install_supabase_skill: true,
			install_render_skill: false
		},
		options: {
			include_fastapi_addon: false,
			install_sync_workflow: true
		}
	};
	return { ...base, ...overrides };
}

describe('setup generator', () => {
	it('requires MapTiler', () => {
		const data = manifest({
			services: { ...manifest().services, public_maptiler_api_key: '' }
		});

		expect(validateSetupManifest(data).errors).toContain('MapTiler API key is required.');
	});

	it('normalizes signup domains', () => {
		expect(normalizeDomains('Example.COM\n@newsroom.org, https://bad.example/path')).toEqual([
			'example.com',
			'newsroom.org',
			'bad.example'
		]);
	});

	it('derives self-hosted agent targets from the manifest', () => {
		const target = deriveAgentTargetFromManifest(manifest());

		expect(target.apiBaseUrl).toBe('https://newsroomref.supabase.co/functions/v1');
		expect(target.mcpUrl).toBe('https://newsroomref.supabase.co/functions/v1/mcp-server');
		expect(target.skillUrl).toBe('https://newsroom.example.com/skills/scoutpost.md');
	});

	it('does not require a production app URL during initial setup', () => {
		const result = validateSetupManifest(
			manifest({
				project: { name: 'test-newsroom', app_url: '' },
				frontend: { provider: 'netlify', site_name: 'test-newsroom', production_url: '' }
			})
		);
		const target = deriveAgentTargetFromManifest(
			manifest({
				project: { name: 'test-newsroom', app_url: '' },
				frontend: { provider: 'netlify', site_name: 'test-newsroom', production_url: '' }
			})
		);

		expect(result.errors).not.toContain('App URL is required.');
		expect(result.errors).not.toContain('Production URL is required.');
		expect(target.skillUrl).toBe('https://<your-frontend-domain>/skills/scoutpost.md');
	});

	it('redacts secrets in previews', () => {
		const redacted = redactSetupManifest(manifest());

		expect(redacted.services.gemini_api_key).toBe('gemi…redacted');
		expect(redacted.services.exa_api_key).toBe('exa-…redacted');
		expect(redacted.supabase.access_token).toBe('sbp-…redacted');
		expect(JSON.stringify(redacted)).not.toContain('gemini-secret');
		expect(JSON.stringify(redacted)).not.toContain('exa-secret');
	});

	it('treats exa_api_key as optional — missing Exa key is not a validation error', () => {
		const data = manifest();
		delete data.services.exa_api_key;

		const result = validateSetupManifest(data);

		expect(result.valid).toBe(true);
		expect(result.errors).not.toContain('Exa API key is required.');
	});

	it('shell-escapes single quotes', () => {
		expect(shellEscape("it's fine")).toBe("'it'\\''s fine'");
	});

	it('generates installer, prompt, and onboarding without hosted operational targets', () => {
		const data = manifest();
		const script = buildInstallScript(data);
		const prompt = buildAgentManifestPrompt('./scoutpost-setup.json');
		const docker = buildDockerInstallerInstructions();
		const dockerScript = buildDockerInstallerScript();
		const onboarding = buildNewsroomOnboarding(data);

		expect(script).toContain('selfhost/setup-from-manifest.sh');
		expect(prompt).toContain('Do not ask me to paste secrets into chat.');
		expect(prompt).toContain('Prefer the Docker installer when Docker is available');
		expect(prompt).toContain('Do not fall back to ad hoc host-machine setup');
		expect(prompt).toContain('ghcr.io/buriedsignals/scoutpost-installer:latest');
		expect(prompt).toContain('Install the upstream sync workflow by default');
		expect(prompt).toContain('For future downstream updates');
		expect(prompt).toContain('supabase.access_token');
		expect(prompt).toContain('maintenance reporting');
		expect(docker).toContain('deploy/installer/Dockerfile');
		expect(docker).toContain('recommended self-host setup path');
		expect(docker).toContain('ghcr.io/buriedsignals/scoutpost-installer:latest install');
		expect(docker).toContain('Downstream updates');
		expect(docker).toContain(
			'-v "$PWD/scoutpost-setup.json:/config/scoutpost-setup.json:ro"'
		);
		expect(docker).toContain('Do not paste scoutpost-setup.json into chat.');
		expect(dockerScript).toContain('ghcr.io/buriedsignals/scoutpost-installer:latest');
		expect(dockerScript).toContain('log() { printf "\\n== %s ==\\n" "$1" >&2; }');
		expect(dockerScript).toContain('docker pull "$IMAGE" >&2');
		expect(dockerScript).toContain('if [ -t 0 ] && [ -t 1 ]; then');
		expect(dockerScript).toContain('scoutpost-os');
		expect(dockerScript).toContain(
			'docker build -f "$build_repo/deploy/installer/Dockerfile" -t "$LOCAL_IMAGE" "$build_repo" >&2'
		);
		expect(dockerScript).toContain('SCOUTPOST_SETUP_MANIFEST');
		expect(onboarding).toContain('https://newsroomref.supabase.co/functions/v1');
		expect(onboarding).toContain('If you use ChatGPT in the browser');
		expect(onboarding).toContain('click Connect Agent');
		expect(onboarding).not.toContain('click Agents');
		expect(onboarding).not.toContain('anon-secret');
		expect(`${prompt}\n${docker}\n${onboarding}`).not.toContain('www.scoutpost.ai');
	});

	it('supports manual provider manifests without Supabase credentials', () => {
		const data = manifest({
			data_platform: {
				provider: 'manual',
				provider_name: 'Internal platform',
				integration_mode: 'manual',
				docs_urls: ['https://platform.example.com/database'],
				operator_notes: 'Use company auth and approved managed Postgres.'
			},
			supabase: {
				mode: 'cloud-create'
			}
		});
		const result = validateSetupManifest(data);
		const prompt = buildAgentManifestPrompt('./scoutpost-setup.json', data);
		const packet = buildProviderPortingPacket(data, './scoutpost-setup.json');
		const target = deriveAgentTargetFromManifest(data);

		expect(result.valid).toBe(true);
		expect(result.errors).not.toContain('Supabase organization ID is required.');
		expect(prompt).toContain('manual provider path');
		expect(prompt).toContain('docs/supabase/migrations.md');
		expect(prompt).toContain('supabase/migrations/');
		expect(prompt).toContain('Fetch current official provider documentation');
		expect(prompt).toContain('explicit human approval');
		expect(prompt).toContain('Do not run Supabase CLI commands');
		expect(packet).toContain('Provider: Internal platform');
		expect(packet).toContain('Migration index: docs/supabase/migrations.md');
		expect(packet).toContain('Migration directory: supabase/migrations/');
		expect(packet).toContain('Human review gate');
		expect(target.deploymentKind).toBe('manual');
		expect(target.apiBaseUrl).toBe('https://<your-api-base-url>');
	});
});

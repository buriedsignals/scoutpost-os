import { describe, expect, it } from 'vitest';
import {
	buildAgentManifestPrompt,
	buildDockerInstallerInstructions,
	buildDockerInstallerScript,
	buildInstallScript,
	buildNewsroomOnboarding,
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
			apify_api_token: 'apify-secret',
			resend_api_key: 'resend-secret',
			resend_from_email: 'scouts@example.com',
			public_maptiler_api_key: 'maptiler-secret'
		},
		auth: {
			admin_email: 'admin@example.com',
			signup_allowed_domains: ['example.com']
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
		expect(target.skillUrl).toBe('https://newsroom.example.com/skills/cojournalist.md');
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
		expect(target.skillUrl).toBe('https://<your-frontend-domain>/skills/cojournalist.md');
	});

	it('redacts secrets in previews', () => {
		const redacted = redactSetupManifest(manifest());

		expect(redacted.services.gemini_api_key).toBe('gemi…redacted');
		expect(redacted.supabase.access_token).toBe('sbp-…redacted');
		expect(JSON.stringify(redacted)).not.toContain('gemini-secret');
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

		expect(script).toContain('automation/setup-from-manifest.sh');
		expect(prompt).toContain('Do not ask me to paste secrets into chat.');
		expect(prompt).toContain('Prefer the Docker installer when Docker is available');
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
		expect(onboarding).toContain('click Agents');
		expect(onboarding).not.toContain('anon-secret');
		expect(`${prompt}\n${docker}\n${onboarding}`).not.toContain('www.scoutpost.ai');
	});
});

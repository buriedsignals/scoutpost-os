import { describe, expect, it } from 'vitest';
import { getAgentRecipes, getSetupPrompt } from '$lib/utils/agent-recipes';
import { resolveAgentTargetContext } from '$lib/utils/agent-targets';
import { normalizeAgentSlug } from '$lib/utils/agent-icons';

describe('agent target resolution', () => {
	it('uses hosted endpoints on the SaaS host', () => {
		const target = resolveAgentTargetContext({
			deploymentTarget: 'supabase',
			supabaseUrl: 'https://newsroom.supabase.co',
			origin: 'https://www.cojournalist.ai',
			hostname: 'www.cojournalist.ai'
		});

		expect(target.mcpUrl).toBe('https://www.cojournalist.ai/mcp');
		expect(target.apiBaseUrl).toBe('https://www.cojournalist.ai/functions/v1');
	});

	it('uses the newsroom Supabase project for self-hosted recipes', () => {
		const target = resolveAgentTargetContext({
			deploymentTarget: 'supabase',
			supabaseUrl: 'https://newsroom.supabase.co',
			supabaseAnonKey: 'anon-newsroom',
			origin: 'https://newsroom.example.com',
			hostname: 'newsroom.example.com'
		});

		const recipes = getAgentRecipes('codex-cli', target);
		const cliConfig = recipes.recipes.cli?.configCommands?.join('\n') ?? '';
		const prompt = getSetupPrompt('codex-cli', 'cli', target);
		const mcpRecipes = getAgentRecipes('codex-mcp', target);
		const mcpSnippet = mcpRecipes.recipes.mcp?.configSnippet ?? '';

		expect(cliConfig).toContain('cojo config set api_url=https://newsroom.supabase.co/functions/v1');
		expect(cliConfig).toContain('cojo config set supabase_anon_key=anon-newsroom');
		expect(prompt).toContain('https://newsroom.example.com');
		expect(prompt).toContain('https://newsroom.supabase.co/functions/v1');
		expect(mcpSnippet).toContain('https://newsroom.supabase.co/functions/v1/mcp-server');
		expect(`${cliConfig}\n${prompt}\n${mcpSnippet}`).not.toContain('www.cojournalist.ai');
	});

	it('uses a custom MCP URL when one is configured', () => {
		const target = resolveAgentTargetContext({
			deploymentTarget: 'supabase',
			supabaseUrl: 'https://newsroom.supabase.co',
			origin: 'https://newsroom.example.com',
			hostname: 'newsroom.example.com',
			customMcpUrl: 'https://newsroom.example.com/mcp/'
		});

		expect(target.mcpUrl).toBe('https://newsroom.example.com/mcp');
		expect(getSetupPrompt('claude-code', 'mcp', target)).toContain('https://newsroom.example.com/mcp');
	});

	it('normalizes the legacy Codex selector value to Codex CLI', () => {
		expect(normalizeAgentSlug('codex')).toBe('codex-cli');
	});

	it('keeps Claude Cowork manual-only with the public walkthrough video', () => {
		const recipe = getAgentRecipes('claude-cowork').recipes.mcp;

		expect(recipe?.setupKind).toBe('manual');
		expect(recipe?.video?.src).toBe('/videos/claude-cowork-connect.mp4');
	});

	it('uses doc-grounded MCP config for Codex, Hermes, and Gemini CLI', () => {
		const codexMcp = getAgentRecipes('codex-mcp').recipes.mcp;
		const hermesMcp = getAgentRecipes('hermes').recipes.mcp;
		const geminiMcp = getAgentRecipes('gemini-cli').recipes.mcp;

		expect(codexMcp?.configSnippet).toContain('[mcp_servers.cojournalist]');
		expect(codexMcp?.verifySteps?.join('\n')).toContain('codex mcp login cojournalist');
		expect(hermesMcp?.configSnippet).toContain('auth: oauth');
		expect(geminiMcp?.command).toContain('gemini mcp add --transport http cojournalist');
	});
});

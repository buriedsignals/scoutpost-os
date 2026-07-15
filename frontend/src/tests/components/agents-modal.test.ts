import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AgentsModal from '$lib/components/modals/AgentsModal.svelte';
import AgentSetup from '$lib/components/ui/AgentSetup.svelte';
import { getAgentRecipes } from '$lib/utils/agent-recipes';

beforeEach(() => {
	vi.stubEnv('PUBLIC_DEPLOYMENT_TARGET', 'supabase');
	vi.stubEnv('PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
	vi.stubEnv('PUBLIC_SUPABASE_ANON_KEY', 'test-anon-key');
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe('Connect Agent modal', () => {
	it('shows a selectable prompt when clipboard access is blocked', async () => {
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: { writeText: vi.fn().mockRejectedValue(new Error('blocked')) }
		});

		render(AgentsModal, { props: { open: true } });
		await fireEvent.click(screen.getByRole('button', { name: /copy setup prompt/i }));

		expect(await screen.findByRole('alert')).toHaveTextContent(/clipboard access is blocked/i);
		const fallback = screen.getByRole('textbox') as HTMLTextAreaElement;
		expect(fallback.value).toContain('Connect yourself to Scoutpost');
	});

	it('labels Antigravity JSON as configuration rather than an MCP URL', () => {
		const recipe = getAgentRecipes('gemini-cli').recipes.mcp;
		expect(recipe).toBeDefined();

		render(AgentSetup, { props: { recipe: recipe! } });

		expect(screen.getByText('Configuration')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /copy config/i })).toBeInTheDocument();
		expect(screen.queryByText('Remote MCP URL')).not.toBeInTheDocument();
	});
});

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
	it('shows one secret-free terminal command and a selectable fallback', async () => {
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: { writeText: vi.fn().mockRejectedValue(new Error('blocked')) }
		});

		render(AgentsModal, { props: { open: true } });
		await fireEvent.click(screen.getByRole('button', { name: /copy terminal command/i }));

		expect(await screen.findByRole('alert')).toHaveTextContent(/clipboard access is blocked/i);
		const fallback = screen.getByRole('textbox') as HTMLTextAreaElement;
		expect(fallback.value).toMatch(
			/^npm install --global scoutpost-cli && scout auth login --site 'https?:\/\/[^']+' --label 'Claude Code'$/
		);
		expect(fallback.value).not.toMatch(/cj_|api_key|anon_key/i);
	});

	it('keeps MCP secondary for dual-path agents and direct for MCP-only agents', async () => {
		render(AgentsModal, { props: { open: true } });
		expect(screen.getByRole('button', { name: /copy terminal command/i })).toBeInTheDocument();
		await fireEvent.click(screen.getByRole('button', { name: /use mcp instead/i }));
		expect(screen.getByText(/add scoutpost in your terminal/i)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /use scout cli instead/i })).toBeInTheDocument();
	});

	it('labels Antigravity JSON as configuration rather than an MCP URL', () => {
		const recipe = getAgentRecipes('antigravity').recipes.mcp;
		expect(recipe).toBeDefined();

		render(AgentSetup, { props: { recipe: recipe! } });

		expect(screen.getByText('~/.gemini/config/mcp_config.json')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /^copy$/i })).toBeInTheDocument();
		expect(screen.queryByText('Remote MCP URL')).not.toBeInTheDocument();
	});

	it('restores focus and closes from Escape', async () => {
		const opener = document.createElement('button');
		opener.textContent = 'Open connections';
		document.body.appendChild(opener);
		opener.focus();
		const onClose = vi.fn();

		render(AgentsModal, { props: { open: true, onClose } });
		await fireEvent.keyDown(window, { key: 'Escape' });

		expect(onClose).toHaveBeenCalledOnce();
		expect(document.activeElement).toBe(opener);
		opener.remove();
	});

	it('ignores Escape while the modal is closed', async () => {
		const onClose = vi.fn();
		render(AgentsModal, { props: { open: false, onClose } });

		await fireEvent.keyDown(window, { key: 'Escape' });

		expect(onClose).not.toHaveBeenCalled();
	});

	it('returns to the recommended CLI path when reopened', async () => {
		const { rerender } = render(AgentsModal, { props: { open: true } });
		await fireEvent.click(screen.getByRole('button', { name: /use mcp instead/i }));
		expect(screen.getByRole('button', { name: /use scout cli instead/i })).toBeInTheDocument();

		await rerender({ open: false });
		await rerender({ open: true });

		expect(screen.getByRole('button', { name: /copy terminal command/i })).toBeInTheDocument();
	});
});

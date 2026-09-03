import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AgentsModal from '$lib/components/modals/AgentsModal.svelte';
import AgentSetup from '$lib/components/ui/AgentSetup.svelte';
import { getAgentRecipes } from '$lib/utils/agent-recipes';
import { AGENTS } from '$lib/utils/agent-icons';
import oneClickFixture from '$lib/vendor/agent-connect/one-click.json';

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
			/^npm install --global scoutpost-cli\nscout auth login --site https?:\/\/\S+ --label "Claude Code"$/
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
		expect(screen.getAllByRole('button', { name: /^copy$/i }).length).toBeGreaterThan(0);
		expect(screen.queryByText('Remote MCP URL')).not.toBeInTheDocument();
		expect(screen.getByText(/click Authenticate/i)).toBeInTheDocument();
		expect(screen.getByText(/copy the authorization code/i)).toBeInTheDocument();
		expect(screen.getByText(/click Submit/i)).toBeInTheDocument();
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

	it('renders an Install block and the onboarding prompt for every catalog recipe', () => {
		for (const agent of AGENTS) {
			const all = getAgentRecipes(agent.slug);
			for (const path of all.paths) {
				const recipe = all.recipes[path]!;
				const { container, unmount } = render(AgentSetup, { props: { recipe } });
				const labels = [...container.querySelectorAll('.block-label')].map((el) => el.textContent?.trim() ?? '');
				expect(labels, `${agent.slug}/${path}`).toContain('Onboard your agent');
				expect(
					labels.some((label) => label.startsWith('Install') || label === 'MCP server URL' || label === 'Configuration'),
					`${agent.slug}/${path} has no install block: ${labels.join(' | ')}`
				).toBe(true);
				expect(container.textContent).not.toContain('Run this in your terminal</span>');
				unmount();
				cleanup();
			}
		}
	});

	it('leads desktop apps with in-app steps or a one-click link, never a terminal command', () => {
		const chatgpt = getAgentRecipes('chatgpt-desktop').recipes.mcp!;
		const { container } = render(AgentSetup, { props: { recipe: chatgpt } });
		expect(container.textContent).toContain('Settings → MCP servers → Add server');
		expect(container.textContent).not.toContain('codex mcp add');
		expect(screen.getByText('MCP server URL')).toBeInTheDocument();
		cleanup();

		const goose = getAgentRecipes('goose').recipes.mcp!;
		render(AgentSetup, { props: { recipe: goose } });
		const link = screen.getByRole('link', { name: 'Add to Goose' }) as HTMLAnchorElement;
		expect(link.href).toBe(oneClickFixture.scoutpost.goose);
		expect(screen.getByText(/Extensions → Add custom extension/)).toBeInTheDocument();
		cleanup();

		const cursor = getAgentRecipes('cursor').recipes.mcp!;
		render(AgentSetup, { props: { recipe: cursor } });
		const cursorLink = screen.getByRole('link', { name: 'Add to Cursor' }) as HTMLAnchorElement;
		expect(cursorLink.href).toBe(oneClickFixture.scoutpost.cursor);
		expect(screen.getByText('Or add to ~/.cursor/mcp.json')).toBeInTheDocument();
	});

	it('shows Install and Onboard your agent on the recommended CLI card', () => {
		render(AgentsModal, { props: { open: true } });
		expect(screen.getByText('Recommended')).toBeInTheDocument();
		expect(screen.getByText('Onboard your agent')).toBeInTheDocument();
		expect(screen.queryByText('Recommended · CLI')).not.toBeInTheDocument();
	});
});

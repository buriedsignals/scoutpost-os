/**
 * Shared agent metadata — used by the login "Works with" pills and by the
 * Agents modal dropdown. Icons are inline SVG path strings so they render
 * without a bundler and match the login page exactly.
 */

export type AgentSlug =
	| 'claude-code'
	| 'claude-cowork'
	| 'codex-cli'
	| 'codex-mcp'
	| 'cursor'
	| 'windsurf'
	| 'gemini-cli'
	| 'goose'
	| 'openclaw'
	| 'hermes'
	| 'langdock'
	| 'other';

export interface AgentMeta {
	slug: AgentSlug;
	name: string;
	/** Raw inner-SVG markup (drops into <svg viewBox="0 0 24 24" ...>). */
	iconInner: string;
}

export const AGENTS: AgentMeta[] = [
	{
		slug: 'claude-code',
		name: 'Claude Code',
		iconInner: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>'
	},
	{
		slug: 'claude-cowork',
		// Same custom-connector flow works in Claude Desktop, claude.ai, and
		// Cowork — Cowork is Anthropic's umbrella product surface for it.
		name: 'Claude Cowork',
		iconInner:
			'<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.582a.5.5 0 0 1 0 .962L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>'
	},
	{
		slug: 'codex-cli',
		name: 'Codex CLI',
		iconInner: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>'
	},
	{
		slug: 'codex-mcp',
		name: 'Codex MCP',
		iconInner: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>'
	},
	{
		slug: 'cursor',
		name: 'Cursor',
		iconInner:
			'<path d="m3 3 7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/><path d="m13 13 6 6"/>'
	},
	{
		slug: 'windsurf',
		name: 'Windsurf',
		iconInner:
			'<path d="M9.59 4.59A2 2 0 1 1 11 8H2m10.59 11.41A2 2 0 1 0 14 16H2m15.73-8.27A2.5 2.5 0 1 1 19.5 12H2"/>'
	},
	{
		slug: 'gemini-cli',
		name: 'Antigravity',
		iconInner:
			'<path d="M12 3L9.5 9.5 3 12l6.5 2.5L12 21l2.5-6.5L21 12l-6.5-2.5z"/>'
	},
	{
		slug: 'goose',
		name: 'Goose',
		iconInner:
			'<path d="M16 7h.01"/><path d="M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20"/><path d="m20 7 2 .5-2 .5"/><path d="M10 18v3"/><path d="M14 17.75V21"/><path d="M7 18a6 6 0 0 0 3.84-10.61"/>'
	},
	{
		slug: 'openclaw',
		name: 'OpenClaw',
		iconInner:
			'<path d="M6 18h8"/><path d="M3 22h18"/><path d="M14 22a7 7 0 1 0 0-14h-1"/><path d="M9 14h2"/><path d="M9 12a2 2 0 0 1 2-2V6l-4-4h3l1 2"/><path d="M4 4h3l1 2"/>'
	},
	{
		slug: 'hermes',
		name: 'Hermes',
		iconInner:
			'<rect width="16" height="20" x="4" y="2" rx="2"/><line x1="8" x2="16" y1="6" y2="6"/><line x1="8" x2="16" y1="14" y2="14"/><line x1="10" x2="10" y1="18" y2="18"/><line x1="14" x2="14" y1="18" y2="18"/>'
	},
	{
		slug: 'langdock',
		name: 'Langdock',
		iconInner:
			'<rect width="16" height="16" x="4" y="4" rx="2"/><path d="M8 9h8"/><path d="M8 13h5"/><path d="m15 15 3 3"/>'
	},
	{
		slug: 'other',
		name: 'Other / generic MCP',
		iconInner:
			'<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/><path d="M7 12h10"/>'
	}
];

export function normalizeAgentSlug(value: string | null | undefined): AgentSlug {
	if (value === 'codex') return 'codex-cli';
	const match = AGENTS.find((a) => a.slug === value);
	return match?.slug ?? AGENTS[0].slug;
}

export function getAgent(slug: AgentSlug): AgentMeta {
	return AGENTS.find((a) => a.slug === slug) ?? AGENTS[AGENTS.length - 1];
}

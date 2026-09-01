/**
 * Icon metadata for the canonical AgentConnect catalog. Agent identity, order,
 * title, visibility, and recipe paths are generated upstream.
 */

import catalog from '../vendor/agent-connect/catalog.json';

export type AgentSlug = keyof typeof catalog.products.scoutpost;
type AgentCatalogEntry = {
  cli?: { title: string };
  mcp?: { title: string };
};
const agentCatalog = catalog.products.scoutpost as Record<AgentSlug, AgentCatalogEntry>;


export interface AgentMeta {
  slug: AgentSlug;
  name: string;
  iconInner: string;
}

const AGENT_ICONS: Record<AgentSlug, string> = {
  'claude-code': '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
  'claude-desktop': '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.582a.5.5 0 0 1 0 .962L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>',
  'chatgpt-desktop': '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  codex: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  antigravity: '<path d="M12 3L9.5 9.5 3 12l6.5 2.5L12 21l2.5-6.5L21 12l-6.5-2.5z"/>',
  gemini: '<path d="M12 2l2.2 7.8L22 12l-7.8 2.2L12 22l-2.2-7.8L2 12l7.8-2.2z"/>',
  goose: '<path d="M16 7h.01"/><path d="M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20"/><path d="m20 7 2 .5-2 .5"/>',
  opencode: '<polyline points="8 9 5 12 8 15"/><polyline points="16 9 19 12 16 15"/><line x1="14" y1="5" x2="10" y2="19"/>',
  'lm-studio': '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  'generic-mcp': '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/><path d="M7 12h10"/>',
};

function catalogTitle(slug: AgentSlug): string {
  const recipes = agentCatalog[slug];
  return (recipes.cli ?? recipes.mcp)?.title ?? slug;
}

export const AGENTS: AgentMeta[] = (Object.keys(catalog.products.scoutpost) as AgentSlug[]).map((slug) => ({
  slug,
  name: catalogTitle(slug),
  iconInner: AGENT_ICONS[slug],
}));

const LEGACY_AGENT_SLUGS: Readonly<Record<string, AgentSlug>> = {
  'claude-cowork': 'claude-desktop',
  'codex-cli': 'codex',
  'codex-mcp': 'codex',
  cursor: 'generic-mcp',
  windsurf: 'generic-mcp',
  'gemini-cli': 'antigravity',
  openclaw: 'generic-mcp',
  hermes: 'generic-mcp',
  langdock: 'generic-mcp',
  other: 'generic-mcp',
};

export function normalizeAgentSlug(value: string | null | undefined): AgentSlug {
  const normalized = value ? LEGACY_AGENT_SLUGS[value] ?? value : AGENTS[0].slug;
  const match = AGENTS.find((agent) => agent.slug === normalized);
  return match?.slug ?? AGENTS[0].slug;
}

export function getAgent(slug: AgentSlug): AgentMeta {
  return AGENTS.find((agent) => agent.slug === slug) ?? AGENTS[AGENTS.length - 1];
}

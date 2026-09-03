/**
 * Scoutpost adapts the generated @buriedsignals/agent-connect catalog for its
 * modal. Agent visibility, supported paths, presentation method, commands,
 * steps, deep links, and caveats all come from that catalog; this module owns
 * presentation shape and the Scoutpost onboarding prompt only.
 */

import { type AgentSlug } from "./agent-icons";
import { type AgentTargetContext, HOSTED_AGENT_TARGET } from "./agent-targets";
import catalog from "../vendor/agent-connect/catalog.json";

export type InstallPath = "cli" | "mcp";
type CatalogMethod = "command" | "ui-steps" | "config-file" | "one-click";
interface CatalogRecipe {
  title: string;
  tagline: string;
  method: CatalogMethod;
  command: string;
  configPath: string | null;
  oneClick: { label: string; url: string } | null;
  steps: string[];
  verify: string;
  onboardHint: string;
  docsUrl: string;
  caveat: string | null;
}

type CatalogProduct = Partial<Record<InstallPath, CatalogRecipe>>;
const agentCatalog = catalog.products.scoutpost as Record<AgentSlug, CatalogProduct>;


export type RecipeMode =
  | "cli-command"
  | "cli-install"
  | "config-file"
  | "ui-steps"
  | "one-click"
  | "generic";

export type RecipeSetupKind = "automated-cli" | "manual";

export interface RecipeWarning {
  title: string;
  body: string;
}

export interface Recipe {
  tagline: string;
  setupKind: RecipeSetupKind;
  warning?: RecipeWarning;
  mode: RecipeMode;
  command?: string;
  installCommand?: string;
  configCommands?: string[];
  configPath?: string;
  configSnippet?: string;
  configLang?: "json" | "toml" | "yaml";
  oneClick?: { label: string; url: string };
  uiSteps?: string[];
  onboardHint?: string;
  onboardPrompt?: string;
  video?: {
    src: string;
    title: string;
  };
  docsUrl?: string;
  docsLabel?: string;
  verifyPrompt?: string;
  verifySteps?: string[];
}

export const CLI_README_URL =
  "https://github.com/buriedsignals/scoutpost-os/blob/master/cli/README.md";
export const MCP_URL = HOSTED_AGENT_TARGET.mcpUrl;
export const SKILL_URL = HOSTED_AGENT_TARGET.skillUrl;

const CLAUDE_CONNECTOR_VIDEO = {
  src: "/videos/claude-cowork-connect.mp4",
  title: "Claude connector walkthrough",
} as const;

function base64Url(value: string): string {
  return encodeURIComponent(globalThis.btoa(value));
}

// Keep in step with Engine `fillCatalogString` and Navigator `fillCatalog()`.
export function fill(template: string, target: AgentTargetContext): string {
  return template
    .replace(/\{\{MCP_URL_JSON_B64\}\}/g, base64Url(JSON.stringify({ url: target.mcpUrl })))
    .replace(/\{\{MCP_URL_ENC\}\}/g, encodeURIComponent(target.mcpUrl))
    .replace(/\{\{DISPLAY_NAME_ENC\}\}/g, encodeURIComponent("Scoutpost"))
    .replace(/\{\{MCP_URL\}\}/g, target.mcpUrl)
    .replace(/\{\{API_BASE_URL\}\}/g, target.apiBaseUrl)
    .replace(/\{\{APP_URL\}\}/g, target.appUrl)
    .replace(/\{\{SKILL_URL\}\}/g, target.skillUrl)
    .replace(/\{\{DISPLAY_NAME\}\}/g, "Scoutpost")
    .replace(/\{\{SERVER_ID\}\}/g, "scoutpost")
    .replace(/\{\{CLI_BINARY\}\}/g, "scout")
    .replace(/\{\{CLI_INSTALL\}\}/g, "npm install --global scoutpost-cli")
    .replace(/\{\{CLI_LOGIN\}\}/g, `scout auth login --site '${target.appUrl}'`)
    .replace(/\{\{DOCS_URL\}\}/g, "https://www.scoutpost.ai/docs");
}

const MODE_BY_METHOD: Record<CatalogMethod, RecipeMode> = {
  command: "cli-command",
  "ui-steps": "ui-steps",
  "config-file": "config-file",
  "one-click": "one-click",
};

/**
 * The "Onboard your agent" text. Scoutpost's product instructions live in the
 * skill file; the prompt points the agent at it once the connection exists.
 */
export function getOnboardPrompt(
  slug: AgentSlug,
  path: InstallPath,
  target: AgentTargetContext = HOSTED_AGENT_TARGET,
): string {
  const raw = agentCatalog[slug][path] ?? agentCatalog[slug].mcp ?? agentCatalog[slug].cli;
  const title = raw ? fill(raw.title, target) : slug;
  if (path === "cli") {
    return [
      "Use the scout CLI, already installed and signed in on this computer, whenever I ask about my scouts, monitoring, or alerts.",
      `Run scout --help once and read the Scoutpost skill at ${target.skillUrl} before your first answer.`,
      `Agent: ${title}.`,
    ].join("\n");
  }
  return [
    "Use the scoutpost MCP server whenever I ask about my scouts, monitoring, or alerts.",
    `Read the Scoutpost skill at ${target.skillUrl} before your first answer.`,
    `Agent: ${title}.`,
  ].join("\n");
}

function catalogRecipe(
  slug: AgentSlug,
  path: InstallPath,
  target: AgentTargetContext,
): Recipe {
  const raw = agentCatalog[slug][path];
  if (!raw) throw new Error(`${slug} catalog ${path} recipe is missing`);

  const command = fill(raw.command, target);
  const steps = raw.steps.map((step) => fill(step, target));
  const mode = MODE_BY_METHOD[raw.method] ?? "generic";
  const isJson = command.trimStart().startsWith("{");

  return {
    tagline: fill(raw.tagline, target),
    setupKind: path === "cli" ? "automated-cli" : "manual",
    mode,
    command: mode === "cli-command" ? command : undefined,
    configSnippet: mode === "cli-command" ? undefined : command,
    configLang: isJson ? "json" : undefined,
    configPath: raw.configPath ? fill(raw.configPath, target) : undefined,
    oneClick: raw.oneClick
      ? { label: raw.oneClick.label, url: fill(raw.oneClick.url, target) }
      : undefined,
    uiSteps: steps,
    onboardHint: fill(raw.onboardHint, target),
    onboardPrompt: getOnboardPrompt(slug, path, target),
    docsUrl: fill(raw.docsUrl, target),
    docsLabel: `${fill(raw.title, target)} docs`,
    verifyPrompt: fill(raw.verify, target),
    warning: raw.caveat
      ? { title: "Connection availability", body: fill(raw.caveat, target) }
      : undefined,
    video: slug === "claude-desktop" ? CLAUDE_CONNECTOR_VIDEO : undefined,
  };
}

export interface AgentRecipes {
  paths: InstallPath[];
  default: InstallPath;
  recipes: Partial<Record<InstallPath, Recipe>>;
}

export function getAgentRecipes(
  slug: AgentSlug,
  target: AgentTargetContext = HOSTED_AGENT_TARGET,
): AgentRecipes {
  const raw = agentCatalog[slug];
  const paths = (Object.keys(raw) as InstallPath[]).filter((path) => raw[path] !== undefined);
  const recipes = Object.fromEntries(
    paths.map((path) => [path, catalogRecipe(slug, path, target)]),
  ) as Partial<Record<InstallPath, Recipe>>;
  const defaultPath = paths[0];
  if (!defaultPath) throw new Error(`${slug} has no AgentConnect recipe`);
  return { paths, default: defaultPath, recipes };
}

export function buildCliLoginCommand(
  slug: AgentSlug,
  target: AgentTargetContext = HOSTED_AGENT_TARGET,
): string {
  const recipe = agentCatalog[slug].cli;
  if (!recipe) throw new Error(`${slug} has no CLI recipe`);
  return fill(recipe.command, target);
}

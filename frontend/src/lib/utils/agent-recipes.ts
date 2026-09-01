/**
 * Scoutpost adapts the generated @buriedsignals/agent-connect catalog for its
 * modal. Agent visibility, supported paths, commands, steps, and caveats all
 * come from that catalog; this module owns presentation shape only.
 */

import { type AgentSlug } from "./agent-icons";
import { type AgentTargetContext, HOSTED_AGENT_TARGET } from "./agent-targets";
import catalog from "../vendor/agent-connect/catalog.json";

export type InstallPath = "cli" | "mcp";
interface CatalogRecipe {
  title: string;
  tagline: string;
  command: string;
  configPath: string | null;
  steps: string[];
  verify: string;
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
  uiSteps?: string[];
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

function fill(template: string, target: AgentTargetContext): string {
  return template
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

function catalogRecipe(
  slug: AgentSlug,
  path: InstallPath,
  target: AgentTargetContext,
): Recipe {
  const raw = agentCatalog[slug][path];
  if (!raw) throw new Error(`${slug} catalog ${path} recipe is missing`);

  const command = fill(raw.command, target);
  const steps = raw.steps.map((step) => fill(step, target));
  const configCommand = command.trimStart().startsWith("{");
  const uiOnly = slug === "claude-desktop"
    || slug === "chatgpt-desktop"
    || slug === "generic-mcp";
  const mode: RecipeMode = path === "cli"
    ? "cli-command"
    : configCommand ? "config-file" : uiOnly ? "ui-steps" : "cli-command";

  return {
    tagline: fill(raw.tagline, target),
    setupKind: path === "cli" ? "automated-cli" : "manual",
    mode,
    command: mode === "cli-command" ? command : undefined,
    configSnippet: mode === "config-file" || mode === "ui-steps" ? command : undefined,
    configLang: configCommand ? "json" : undefined,
    configPath: raw.configPath ? fill(raw.configPath, target) : undefined,
    uiSteps: steps,
    docsUrl: raw.docsUrl,
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

export function getSetupPrompt(
  slug: AgentSlug,
  path: InstallPath = "cli",
  target: AgentTargetContext = HOSTED_AGENT_TARGET,
): string {
  const recipe = catalogRecipe(slug, path, target);
  if (path === "mcp") {
    return [
      recipe.tagline,
      recipe.configSnippet ?? recipe.command ?? target.mcpUrl,
      ...(recipe.uiSteps ?? []),
      `Read the Scoutpost product instructions at ${target.skillUrl}.`,
      `Verify: ${recipe.verifyPrompt ?? "List my Scoutpost scouts."}`,
    ].join("\n\n");
  }
  return recipe.command ?? buildCliLoginCommand(slug, target);
}

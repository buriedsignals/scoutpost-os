import { describe, expect, it } from "vitest";
import {
  buildCliLoginCommand,
  getAgentRecipes,
  getSetupPrompt,
} from "$lib/utils/agent-recipes";
import { resolveAgentTargetContext } from "$lib/utils/agent-targets";
import { AGENTS, normalizeAgentSlug } from "$lib/utils/agent-icons";

describe("agent target resolution", () => {
  it("uses hosted endpoints on the SaaS host", () => {
    const target = resolveAgentTargetContext({
      deploymentTarget: "supabase",
      supabaseUrl: "https://newsroom.supabase.co",
      origin: "https://www.scoutpost.ai",
      hostname: "www.scoutpost.ai",
    });

    expect(target.mcpUrl).toBe("https://scoutpost.ai/mcp");
    expect(target.apiBaseUrl).toBe("https://scoutpost.ai/functions/v1");
  });

  it("uses one catalog for self-hosted Codex CLI and MCP", () => {
    const target = resolveAgentTargetContext({
      deploymentTarget: "supabase",
      supabaseUrl: "https://newsroom.supabase.co",
      supabaseAnonKey: "anon-newsroom",
      origin: "https://newsroom.example.com",
      hostname: "newsroom.example.com",
    });

    const recipes = getAgentRecipes("codex", target);
    const cliCommand = recipes.recipes.cli?.command ?? "";
    const mcpCommand = recipes.recipes.mcp?.command ?? "";

    expect(recipes.paths).toEqual(["cli", "mcp"]);
    expect(cliCommand).toBe(
      'npm install --global scoutpost-cli\nscout auth login --site https://newsroom.example.com --label "Codex"',
    );
    expect(mcpCommand).toContain(
      "codex mcp add scoutpost --url https://newsroom.supabase.co/functions/v1/mcp-server",
    );
    expect(mcpCommand).toContain("codex mcp login scoutpost");
  });

  it("uses a custom MCP URL when configured", () => {
    const target = resolveAgentTargetContext({
      deploymentTarget: "supabase",
      supabaseUrl: "https://newsroom.supabase.co",
      origin: "https://newsroom.example.com",
      hostname: "newsroom.example.com",
      customMcpUrl: "https://newsroom.example.com/mcp/",
    });

    expect(target.mcpUrl).toBe("https://newsroom.example.com/mcp");
    expect(getSetupPrompt("claude-code", "mcp", target)).toContain(
      "https://newsroom.example.com/mcp",
    );
  });

  it("builds secret-free CLI commands from the generated catalog", () => {
    const command = buildCliLoginCommand("claude-code");
    expect(command).toBe(
      'npm install --global scoutpost-cli\nscout auth login --site https://scoutpost.ai --label "Claude Code"',
    );
    expect(command).not.toMatch(/cj_|api_key|anon_key|auth_token/i);
  });

  it("normalizes retired selector values into the canonical catalog", () => {
    expect(normalizeAgentSlug("codex-cli")).toBe("codex");
    expect(normalizeAgentSlug("codex-mcp")).toBe("codex");
    expect(normalizeAgentSlug("claude-cowork")).toBe("claude-desktop");
    expect(normalizeAgentSlug("gemini-cli")).toBe("antigravity");
    expect(normalizeAgentSlug("cursor")).toBe("generic-mcp");
  });

  it("keeps the menu and generated recipe catalog in lockstep", () => {
    expect(AGENTS.map((agent) => agent.slug)).toEqual([
      "claude-code",
      "claude-desktop",
      "chatgpt-desktop",
      "codex",
      "antigravity",
      "gemini",
      "goose",
      "opencode",
      "lm-studio",
      "generic-mcp",
    ]);
    expect(getAgentRecipes("claude-code").paths).toEqual(["cli", "mcp"]);
    expect(getAgentRecipes("antigravity").paths).toEqual(["cli", "mcp"]);
    expect(getAgentRecipes("antigravity").default).toBe("cli");
    expect(getAgentRecipes("gemini").paths).toEqual(["cli"]);
    expect(getAgentRecipes("generic-mcp").paths).toEqual(["mcp"]);
  });

  it("adapts catalog MCP recipes to the correct presentation", () => {
    const antigravity = getAgentRecipes("antigravity").recipes.mcp;
    const claude = getAgentRecipes("claude-desktop").recipes.mcp;
    const chatgpt = getAgentRecipes("chatgpt-desktop").recipes.mcp;

    expect(antigravity?.mode).toBe("config-file");
    expect(antigravity?.configSnippet).toContain('"serverUrl"');
    expect(claude?.video?.src).toBe("/videos/claude-cowork-connect.mp4");
    expect(chatgpt?.warning?.body).toMatch(/Business, Enterprise, and Edu/);
  });

  it("builds short verifiable setup prompts", () => {
    const cliPrompt = getSetupPrompt("codex", "cli");
    const mcpPrompt = getSetupPrompt("claude-code", "mcp");

    expect(cliPrompt).toContain("npm install --global scoutpost-cli");
    expect(cliPrompt).toContain("scout auth login");
    expect(mcpPrompt).toContain("claude mcp add");
    expect(mcpPrompt).toContain("Verify:");
  });
});

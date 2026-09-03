import { describe, expect, it } from "vitest";
import {
  buildCliLoginCommand,
  fill,
  getAgentRecipes,
  getOnboardPrompt,
} from "$lib/utils/agent-recipes";
import { resolveAgentTargetContext, HOSTED_AGENT_TARGET } from "$lib/utils/agent-targets";
import { AGENTS, normalizeAgentSlug } from "$lib/utils/agent-icons";
import catalog from "$lib/vendor/agent-connect/catalog.json";
import oneClickFixture from "$lib/vendor/agent-connect/one-click.json";

describe("agent target resolution", () => {
  it("uses the hosted target on scoutpost.ai", () => {
    const target = resolveAgentTargetContext({
      deploymentTarget: "supabase",
      supabaseUrl: "https://ignored.supabase.co",
      origin: "https://scoutpost.ai",
      hostname: "scoutpost.ai",
    });
    expect(target).toEqual(HOSTED_AGENT_TARGET);
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
      'npm install --global scoutpost-cli\nscout auth login --site https://newsroom.example.com --label "Codex CLI"',
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
    const chatgpt = getAgentRecipes("chatgpt-desktop", target).recipes.mcp!;
    expect(chatgpt.configSnippet).toBe("https://newsroom.example.com/mcp");
    expect(chatgpt.uiSteps?.join(" ")).toContain("https://newsroom.example.com/mcp");
    const goose = getAgentRecipes("goose", target).recipes.mcp!;
    expect(goose.oneClick?.url).toContain("url=https%3A%2F%2Fnewsroom.example.com%2Fmcp");
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
    expect(normalizeAgentSlug("gemini-cli")).toBe("gemini");
    expect(normalizeAgentSlug("cursor")).toBe("cursor");
    expect(normalizeAgentSlug("lm-studio")).toBe("generic-mcp");
    expect(normalizeAgentSlug("windsurf")).toBe("generic-mcp");
  });

  it("keeps the menu and generated recipe catalog in lockstep", () => {
    expect(AGENTS.map((agent) => agent.slug)).toEqual([
      "claude-code",
      "claude-desktop",
      "chatgpt-desktop",
      "codex",
      "cursor",
      "antigravity",
      "gemini",
      "goose",
      "opencode",
      "generic-mcp",
    ]);
    expect(AGENTS.map((agent) => agent.slug)).toEqual(Object.keys(catalog.products.scoutpost));
    expect(AGENTS.every((agent) => agent.iconInner.length > 0)).toBe(true);
    expect(getAgentRecipes("claude-code").paths).toEqual(["cli", "mcp"]);
    expect(getAgentRecipes("antigravity").paths).toEqual(["cli", "mcp"]);
    expect(getAgentRecipes("antigravity").default).toBe("cli");
    expect(getAgentRecipes("gemini").paths).toEqual(["cli", "mcp"]);
    expect(getAgentRecipes("opencode").paths).toEqual(["cli", "mcp"]);
    expect(getAgentRecipes("goose").paths).toEqual(["mcp"]);
    expect(getAgentRecipes("cursor").paths).toEqual(["mcp"]);
    expect(getAgentRecipes("generic-mcp").paths).toEqual(["mcp"]);
  });

  it("adapts catalog MCP recipes to the correct presentation", () => {
    const antigravity = getAgentRecipes("antigravity").recipes.mcp;
    const claude = getAgentRecipes("claude-desktop").recipes.mcp;
    const chatgpt = getAgentRecipes("chatgpt-desktop").recipes.mcp;
    const goose = getAgentRecipes("goose").recipes.mcp;
    const cursor = getAgentRecipes("cursor").recipes.mcp;
    const gemini = getAgentRecipes("gemini").recipes.mcp;

    expect(antigravity?.mode).toBe("config-file");
    expect(antigravity?.configSnippet).toContain('"serverUrl"');
    expect(claude?.mode).toBe("ui-steps");
    expect(claude?.video?.src).toBe("/videos/claude-cowork-connect.mp4");

    // ChatGPT Desktop is a desktop app: the card carries the MCP URL and the
    // in-app steps; the Codex command lives on the Codex CLI card only.
    expect(chatgpt?.mode).toBe("ui-steps");
    expect(chatgpt?.command).toBeUndefined();
    expect(chatgpt?.configSnippet).toBe("https://scoutpost.ai/mcp");
    expect(chatgpt?.uiSteps?.join(" ")).toContain("Settings → MCP servers → Add server");
    expect(chatgpt?.uiSteps?.join(" ")).not.toContain("codex mcp add");
    expect(chatgpt?.warning).toBeUndefined();

    expect(goose?.mode).toBe("one-click");
    expect(goose?.oneClick?.label).toBe("Add to Goose");
    expect(goose?.uiSteps?.[0]).not.toContain("goose configure");
    expect(goose?.uiSteps?.at(-1)).toContain("goose configure");

    expect(cursor?.mode).toBe("one-click");
    expect(cursor?.configLang).toBe("json");
    expect(cursor?.configPath).toBe("~/.cursor/mcp.json");

    expect(gemini?.mode).toBe("cli-command");
    expect(gemini?.command).toBe("gemini mcp add --transport http --scope user scoutpost https://scoutpost.ai/mcp");
  });

  it("renders desktop-app recipes without a terminal command as the default", () => {
    for (const slug of ["claude-desktop", "chatgpt-desktop", "cursor", "goose", "generic-mcp"] as const) {
      const recipes = getAgentRecipes(slug);
      const recipe = recipes.recipes[recipes.default]!;
      expect(recipe.mode).not.toBe("cli-command");
      expect(recipe.command).toBeUndefined();
    }
    for (const slug of ["claude-code", "codex", "gemini", "opencode", "antigravity"] as const) {
      const recipes = getAgentRecipes(slug);
      expect(recipes.default).toBe("cli");
      expect(recipes.recipes.cli?.mode).toBe("cli-command");
    }
  });

  it("fills one-click links exactly like Engine's generated fixture", () => {
    for (const slug of ["goose", "cursor"] as const) {
      const recipe = getAgentRecipes(slug).recipes.mcp!;
      expect(recipe.oneClick?.url).toBe(oneClickFixture.scoutpost[slug]);
    }
    expect(fill("{{MCP_URL_JSON_B64}}", HOSTED_AGENT_TARGET)).toBe(
      encodeURIComponent(btoa('{"url":"https://scoutpost.ai/mcp"}')),
    );
    for (const slug of AGENTS.map((agent) => agent.slug)) {
      for (const recipe of Object.values(getAgentRecipes(slug).recipes)) {
        expect(JSON.stringify(recipe)).not.toContain("{{");
      }
    }
  });

  it("builds short onboarding prompts that point at the skill file", () => {
    const cliPrompt = getOnboardPrompt("codex", "cli");
    const mcpPrompt = getOnboardPrompt("claude-desktop", "mcp");

    expect(cliPrompt).toContain("scout CLI");
    expect(cliPrompt).toContain(HOSTED_AGENT_TARGET.skillUrl);
    expect(cliPrompt).toContain("Agent: Codex CLI.");
    expect(mcpPrompt).toContain("scoutpost MCP server");
    expect(mcpPrompt).toContain(HOSTED_AGENT_TARGET.skillUrl);
    expect(mcpPrompt).not.toMatch(/cj_|api_key|anon_key|auth_token/i);
    expect(getAgentRecipes("claude-code").recipes.cli?.onboardPrompt).toBe(getOnboardPrompt("claude-code", "cli"));
    expect(getAgentRecipes("goose").recipes.mcp?.onboardHint).toContain("first message");
  });
});

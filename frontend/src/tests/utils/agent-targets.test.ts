import { describe, expect, it } from "vitest";
import {
  buildCliLoginCommand,
  getAgentRecipes,
  getSetupPrompt,
} from "$lib/utils/agent-recipes";
import { resolveAgentTargetContext } from "$lib/utils/agent-targets";
import { normalizeAgentSlug } from "$lib/utils/agent-icons";

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

  it("canonicalizes legacy hosted origins to Scoutpost", () => {
    const target = resolveAgentTargetContext({
      deploymentTarget: "supabase",
      supabaseUrl: "https://newsroom.supabase.co",
      origin: "https://cojournalist.ai",
      hostname: "cojournalist.ai",
    });

    expect(target.appUrl).toBe("https://scoutpost.ai");
    expect(target.apiBaseUrl).toBe("https://scoutpost.ai/functions/v1");
    expect(target.skillUrl).toBe("https://scoutpost.ai/skills/scoutpost.md");
  });

  it("uses the newsroom Supabase project for self-hosted recipes", () => {
    const target = resolveAgentTargetContext({
      deploymentTarget: "supabase",
      supabaseUrl: "https://newsroom.supabase.co",
      supabaseAnonKey: "anon-newsroom",
      origin: "https://newsroom.example.com",
      hostname: "newsroom.example.com",
    });

    const recipes = getAgentRecipes("codex-cli", target);
    const cliCommand = recipes.recipes.cli?.command ?? "";
    const prompt = getSetupPrompt("codex-cli", "cli", target);
    const mcpRecipes = getAgentRecipes("codex-mcp", target);
    const mcpCommand = mcpRecipes.recipes.mcp?.command ?? "";

    expect(cliCommand).toBe(
      "npm install --global scoutpost-cli && scout auth login --site 'https://newsroom.example.com' --label 'Codex CLI'",
    );
    expect(prompt).toBe(cliCommand);
    expect(mcpCommand).toContain(
      "codex mcp add scoutpost --url https://newsroom.supabase.co/functions/v1/mcp-server",
    );
    expect(mcpCommand).toContain("codex mcp login scoutpost");
    expect(`${cliCommand}\n${prompt}\n${mcpCommand}`).not.toContain(
      "www.scoutpost.ai",
    );
  });

  it("uses a custom MCP URL when one is configured", () => {
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

  it("keeps generated setup prompts short, safe, and verifiable", () => {
    const cliPrompt = getSetupPrompt("codex-cli", "cli");
    const mcpPrompt = getSetupPrompt("claude-code", "mcp");

    expect(cliPrompt).toContain("npm install --global scoutpost-cli");
    expect(cliPrompt).toContain("scout auth login");
    expect(mcpPrompt).toContain("Use OAuth");
    expect(mcpPrompt).toContain("Do not ask me for a JWT or API key");

    for (const prompt of [cliPrompt, mcpPrompt]) {
      expect(prompt).not.toContain("narrating each step");
      expect(prompt).not.toContain("Summarise what Scoutpost lets you do");
      expect(prompt).not.toContain("From now on");
    }
  });

  it("builds a shell-safe command without credentials or manual config", () => {
    const command = buildCliLoginCommand("claude-code");
    expect(command).toBe(
      "npm install --global scoutpost-cli && scout auth login --site 'https://scoutpost.ai' --label 'Claude Code'",
    );
    expect(command).not.toMatch(/cj_|api_key|anon_key|auth_token/i);
  });

  it("normalizes the legacy Codex selector value to Codex CLI", () => {
    expect(normalizeAgentSlug("codex")).toBe("codex-cli");
  });

  it("keeps Claude Cowork manual-only with the public walkthrough video", () => {
    const recipe = getAgentRecipes("claude-cowork").recipes.mcp;

    expect(recipe?.setupKind).toBe("manual");
    expect(recipe?.video?.src).toBe("/videos/claude-cowork-connect.mp4");
  });

  it("uses doc-grounded MCP config for Codex, Hermes, and Antigravity", () => {
    const codexMcp = getAgentRecipes("codex-mcp").recipes.mcp;
    const hermesMcp = getAgentRecipes("hermes").recipes.mcp;
    const antigravityMcp = getAgentRecipes("gemini-cli").recipes.mcp;

    expect(codexMcp?.command).toContain("codex mcp add scoutpost --url");
    expect(codexMcp?.command).toContain("codex mcp login scoutpost");
    expect(codexMcp?.command).not.toMatch(/ChatGPT Desktop/i);
    expect(hermesMcp?.configSnippet).toContain("auth: oauth");
    expect(antigravityMcp?.configSnippet).toContain('"serverUrl"');
    expect(antigravityMcp?.docsUrl).toContain("antigravity.google/docs/mcp");
    expect(antigravityMcp?.uiSteps?.join("\n")).toContain("View raw config");
    expect(antigravityMcp?.uiSteps?.join("\n")).toContain("authorization code");
  });

  it("uses explicit OAuth and connectivity checks in command-driven MCP recipes", () => {
    const claude = getAgentRecipes("claude-code").recipes.mcp;
    const goose = getAgentRecipes("goose").recipes.mcp;
    const openclaw = getAgentRecipes("openclaw").recipes.mcp;

    expect(claude?.uiSteps?.join("\n")).toContain("/mcp");
    expect(claude?.command).toContain("claude mcp add --transport http scoutpost");
    expect(claude?.command).not.toContain("codex");
    expect(goose?.uiSteps?.join("\n")).toContain(
      "Remote Extension (Streamable HTTP)",
    );
    expect(goose?.docsUrl).toContain("getting-started/using-extensions.md");
    expect(openclaw?.command).toContain('"auth":"oauth"');
    expect(openclaw?.verifySteps?.join("\n")).toContain(
      "openclaw mcp login scoutpost",
    );
    expect(openclaw?.verifySteps?.join("\n")).toContain("--probe");
  });

  it("keeps Langdock on the OAuth DCR MCP path", () => {
    const recipes = getAgentRecipes("langdock");
    const recipe = recipes.recipes.mcp;

    expect(recipes.paths).toEqual(["mcp"]);
    expect(recipes.default).toBe("mcp");
    expect(recipe?.setupKind).toBe("manual");
    expect(recipe?.configSnippet).toBe("https://scoutpost.ai/mcp");
    expect(recipe?.tagline).toContain("Dynamic Client Registration");
    expect(recipe?.uiSteps?.join("\n")).toContain("OAuth authentication");
  });

  it("lists ChatGPT Desktop as a supported MCP recipe, distinct from Codex", () => {
    const recipes = getAgentRecipes("chatgpt-desktop");
    const recipe = recipes.recipes.mcp;

    expect(recipes.paths).toEqual(["mcp"]);
    expect(recipes.default).toBe("mcp");
    expect(recipe?.tagline).toMatch(/ChatGPT Desktop/);
    expect(recipe?.uiSteps?.join("\n")).toMatch(/ChatGPT Desktop/);
    expect(recipe?.warning?.body).toMatch(/Business, Enterprise, and Edu/);
    expect(recipe?.command ?? recipe?.configSnippet).not.toMatch(/codex/i);
  });

  it("keeps the unknown generic MCP client on the MCP-first path", () => {
    const recipes = getAgentRecipes("other");

    expect(recipes.paths).toEqual(["cli", "mcp"]);
    expect(recipes.default).toBe("mcp");
  });
});

import { describe, expect, it } from "vitest";
import { getAgentRecipes, getSetupPrompt } from "$lib/utils/agent-recipes";
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
    const cliConfig = recipes.recipes.cli?.configCommands?.join("\n") ?? "";
    const prompt = getSetupPrompt("codex-cli", "cli", target);
    const mcpRecipes = getAgentRecipes("codex-mcp", target);
    const mcpSnippet = mcpRecipes.recipes.mcp?.configSnippet ?? "";

    expect(cliConfig).toContain(
      "scout config set api_url=https://newsroom.supabase.co/functions/v1",
    );
    expect(cliConfig).toContain(
      "scout config set supabase_anon_key=anon-newsroom",
    );
    expect(prompt).toContain("https://newsroom.example.com");
    expect(prompt).toContain("https://newsroom.supabase.co/functions/v1");
    expect(mcpSnippet).toContain(
      "https://newsroom.supabase.co/functions/v1/mcp-server",
    );
    expect(`${cliConfig}\n${prompt}\n${mcpSnippet}`).not.toContain(
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

    expect(cliPrompt).toContain("Never ask me to paste the key into chat");
    expect(cliPrompt).toContain("API keys & REST");
    expect(cliPrompt).toContain("scout scouts list");
    expect(mcpPrompt).toContain("Use OAuth");
    expect(mcpPrompt).toContain("Do not ask me for a JWT or API key");

    for (const prompt of [cliPrompt, mcpPrompt]) {
      expect(prompt).not.toContain("narrating each step");
      expect(prompt).not.toContain("Summarise what Scoutpost lets you do");
      expect(prompt).not.toContain("From now on");
    }
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

    expect(codexMcp?.configSnippet).toContain("[mcp_servers.scoutpost]");
    expect(codexMcp?.verifySteps?.join("\n")).toContain(
      "codex mcp login scoutpost",
    );
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

    expect(claude?.uiSteps?.join("\n")).toContain(
      "claude mcp login scoutpost",
    );
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
});

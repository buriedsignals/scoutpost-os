import * as m from '$lib/paraglide/messages';

// Presentation only. Commands, URLs and connection methods stay in agent-connect.
export const recipeMessages: Record<string, {
  tagline: RecipeMessage;
  verify: RecipeMessage;
  onboardHint: RecipeMessage;
  caveat: RecipeMessage | null;
  oneClickLabel: RecipeMessage | null;
  steps: RecipeMessage[];
}> = {
  "claude-code:cli": {
    tagline: m.agentRecipe_claude_code_cli_tagline,
    verify: m.agentRecipe_claude_code_cli_verify,
    onboardHint: m.agentRecipe_claude_code_cli_onboardHint,
    caveat: null,
    oneClickLabel: null,
    steps: [
      m.agentRecipe_claude_code_cli_step1,
      m.agentRecipe_claude_code_cli_step2,
      m.agentRecipe_claude_code_cli_step3,
    ],
  },
  "claude-code:mcp": {
    tagline: m.agentRecipe_claude_code_mcp_tagline,
    verify: m.agentRecipe_claude_code_mcp_verify,
    onboardHint: m.agentRecipe_claude_code_mcp_onboardHint,
    caveat: null,
    oneClickLabel: null,
    steps: [
      m.agentRecipe_claude_code_mcp_step1,
      m.agentRecipe_claude_code_mcp_step2,
      m.agentRecipe_claude_code_mcp_step3,
    ],
  },
  "claude-desktop:mcp": {
    tagline: m.agentRecipe_claude_desktop_mcp_tagline,
    verify: m.agentRecipe_claude_desktop_mcp_verify,
    onboardHint: m.agentRecipe_claude_desktop_mcp_onboardHint,
    caveat: null,
    oneClickLabel: null,
    steps: [
      m.agentRecipe_claude_desktop_mcp_step1,
      m.agentRecipe_claude_desktop_mcp_step2,
      m.agentRecipe_claude_desktop_mcp_step3,
      m.agentRecipe_claude_desktop_mcp_step4,
      m.agentRecipe_claude_desktop_mcp_step5,
      m.agentRecipe_claude_desktop_mcp_step6,
    ],
  },
  "chatgpt-desktop:mcp": {
    tagline: m.agentRecipe_chatgpt_desktop_mcp_tagline,
    verify: m.agentRecipe_chatgpt_desktop_mcp_verify,
    onboardHint: m.agentRecipe_chatgpt_desktop_mcp_onboardHint,
    caveat: null,
    oneClickLabel: null,
    steps: [
      m.agentRecipe_chatgpt_desktop_mcp_step1,
      m.agentRecipe_chatgpt_desktop_mcp_step2,
      m.agentRecipe_chatgpt_desktop_mcp_step3,
      m.agentRecipe_chatgpt_desktop_mcp_step4,
      m.agentRecipe_chatgpt_desktop_mcp_step5,
    ],
  },
  "codex:cli": {
    tagline: m.agentRecipe_claude_code_cli_tagline,
    verify: m.agentRecipe_claude_code_cli_verify,
    onboardHint: m.agentRecipe_codex_cli_onboardHint,
    caveat: null,
    oneClickLabel: null,
    steps: [
      m.agentRecipe_claude_code_cli_step1,
      m.agentRecipe_claude_code_cli_step2,
      m.agentRecipe_codex_cli_step3,
    ],
  },
  "codex:mcp": {
    tagline: m.agentRecipe_codex_mcp_tagline,
    verify: m.agentRecipe_codex_mcp_verify,
    onboardHint: m.agentRecipe_codex_mcp_onboardHint,
    caveat: null,
    oneClickLabel: null,
    steps: [
      m.agentRecipe_codex_mcp_step1,
      m.agentRecipe_codex_mcp_step2,
      m.agentRecipe_codex_mcp_step3,
    ],
  },
  "cursor:mcp": {
    tagline: m.agentRecipe_cursor_mcp_tagline,
    verify: m.agentRecipe_cursor_mcp_verify,
    onboardHint: m.agentRecipe_cursor_mcp_onboardHint,
    caveat: null,
    oneClickLabel: m.agentRecipe_cursor_mcp_oneClick,
    steps: [
      m.agentRecipe_cursor_mcp_step1,
      m.agentRecipe_cursor_mcp_step2,
      m.agentRecipe_cursor_mcp_step3,
      m.agentRecipe_cursor_mcp_step4,
    ],
  },
  "antigravity:cli": {
    tagline: m.agentRecipe_claude_code_cli_tagline,
    verify: m.agentRecipe_claude_code_cli_verify,
    onboardHint: m.agentRecipe_antigravity_cli_onboardHint,
    caveat: null,
    oneClickLabel: null,
    steps: [
      m.agentRecipe_claude_code_cli_step1,
      m.agentRecipe_claude_code_cli_step2,
      m.agentRecipe_antigravity_cli_step3,
    ],
  },
  "antigravity:mcp": {
    tagline: m.agentRecipe_antigravity_mcp_tagline,
    verify: m.agentRecipe_antigravity_mcp_verify,
    onboardHint: m.agentRecipe_antigravity_mcp_onboardHint,
    caveat: m.agentRecipe_antigravity_mcp_caveat,
    oneClickLabel: null,
    steps: [
      m.agentRecipe_antigravity_mcp_step1,
      m.agentRecipe_antigravity_mcp_step2,
      m.agentRecipe_antigravity_mcp_step3,
      m.agentRecipe_antigravity_mcp_step4,
      m.agentRecipe_antigravity_mcp_step5,
    ],
  },
  "gemini:cli": {
    tagline: m.agentRecipe_claude_code_cli_tagline,
    verify: m.agentRecipe_claude_code_cli_verify,
    onboardHint: m.agentRecipe_gemini_cli_onboardHint,
    caveat: null,
    oneClickLabel: null,
    steps: [
      m.agentRecipe_claude_code_cli_step1,
      m.agentRecipe_claude_code_cli_step2,
      m.agentRecipe_gemini_cli_step3,
    ],
  },
  "gemini:mcp": {
    tagline: m.agentRecipe_gemini_mcp_tagline,
    verify: m.agentRecipe_gemini_mcp_verify,
    onboardHint: m.agentRecipe_gemini_mcp_onboardHint,
    caveat: null,
    oneClickLabel: null,
    steps: [
      m.agentRecipe_gemini_mcp_step1,
      m.agentRecipe_gemini_mcp_step2,
      m.agentRecipe_gemini_mcp_step3,
    ],
  },
  "goose:mcp": {
    tagline: m.agentRecipe_goose_mcp_tagline,
    verify: m.agentRecipe_goose_mcp_verify,
    onboardHint: m.agentRecipe_goose_mcp_onboardHint,
    caveat: null,
    oneClickLabel: null,
    steps: [
      m.agentRecipe_goose_mcp_step1,
      m.agentRecipe_goose_mcp_step2,
      m.agentRecipe_goose_mcp_step3,
      m.agentRecipe_goose_mcp_step4,
      m.agentRecipe_goose_mcp_step5,
    ],
  },
  "opencode:cli": {
    tagline: m.agentRecipe_claude_code_cli_tagline,
    verify: m.agentRecipe_claude_code_cli_verify,
    onboardHint: m.agentRecipe_opencode_cli_onboardHint,
    caveat: null,
    oneClickLabel: null,
    steps: [
      m.agentRecipe_claude_code_cli_step1,
      m.agentRecipe_claude_code_cli_step2,
      m.agentRecipe_opencode_cli_step3,
    ],
  },
  "opencode:mcp": {
    tagline: m.agentRecipe_opencode_mcp_tagline,
    verify: m.agentRecipe_opencode_mcp_verify,
    onboardHint: m.agentRecipe_opencode_mcp_onboardHint,
    caveat: null,
    oneClickLabel: null,
    steps: [
      m.agentRecipe_opencode_mcp_step1,
      m.agentRecipe_opencode_mcp_step2,
    ],
  },
  "generic-mcp:mcp": {
    tagline: m.agentRecipe_generic_mcp_mcp_tagline,
    verify: m.agentRecipe_generic_mcp_mcp_verify,
    onboardHint: m.agentRecipe_generic_mcp_mcp_onboardHint,
    caveat: null,
    oneClickLabel: null,
    steps: [
      m.agentRecipe_generic_mcp_mcp_step1,
      m.agentRecipe_generic_mcp_mcp_step2,
      m.agentRecipe_generic_mcp_mcp_step3,
    ],
  },
};

type RecipeMessage = (inputs: { DISPLAY_NAME: string; CLI_BINARY: string; SERVER_ID: string; MCP_URL: string }) => string;

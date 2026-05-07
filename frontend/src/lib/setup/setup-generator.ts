import type { AgentTargetContext } from "$lib/utils/agent-targets";

export type SupabaseMode = "cloud-create" | "cloud-existing" | "self-hosted";
export type FrontendProvider =
  | "netlify"
  | "vercel"
  | "cloudflare"
  | "render"
  | "manual";

export const DOCKER_INSTALLER_IMAGE =
  "ghcr.io/buriedsignals/scoutpost-installer:latest";

export interface SetupManifest {
  version: 1;
  project: {
    name: string;
    /** Optional during first setup; final deployment/onboarding can fill it later. */
    app_url: string;
  };
  services: {
    gemini_api_key: string;
    firecrawl_api_key: string;
    apify_api_token: string;
    resend_api_key: string;
    resend_from_email: string;
    public_maptiler_api_key: string;
    openrouter_api_key?: string;
  };
  auth: {
    admin_email: string;
    signup_allowed_domains: string[];
  };
  supabase: {
    mode: SupabaseMode;
    project_ref?: string;
    project_url?: string;
    anon_key?: string;
    service_role_key?: string;
    jwt_secret?: string;
    access_token?: string;
    org_id?: string;
    region?: string;
    db_password?: string;
    self_hosted_postgres_password?: string;
  };
  frontend: {
    provider: FrontendProvider;
    site_name?: string;
    /** Optional during first setup; the hosting provider may assign this after deploy. */
    production_url: string;
  };
  agents: {
    custom_mcp_url?: string;
    install_firecrawl_skill: boolean;
    install_supabase_skill: boolean;
    install_render_skill: boolean;
  };
  options: {
    include_fastapi_addon: boolean;
    install_sync_workflow: boolean;
    render_deploy_hook?: string;
  };
}

export interface SetupValidationResult {
  valid: boolean;
  errors: string[];
}

const SECRET_KEYS = new Set([
  "gemini_api_key",
  "firecrawl_api_key",
  "apify_api_token",
  "resend_api_key",
  "public_maptiler_api_key",
  "openrouter_api_key",
  "anon_key",
  "service_role_key",
  "jwt_secret",
  "access_token",
  "db_password",
  "self_hosted_postgres_password",
  "render_deploy_hook",
]);

function trimSlash(value: string): string {
  return value.trim().replace(/\/$/, "");
}

export function normalizeDomains(raw: string | string[]): string[] {
  const values = Array.isArray(raw) ? raw : raw.split(/[\n,]+/);
  const seen = new Set<string>();
  for (const item of values) {
    const domain = item
      .trim()
      .toLowerCase()
      .replace(/^@/, "")
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "");
    if (domain && domain.includes(".") && !domain.includes("@")) {
      seen.add(domain);
    }
  }
  return Array.from(seen);
}

export function shellEscape(value: unknown): string {
  const raw = value == null ? "" : String(value);
  if (!raw) return "''";
  return `'${raw.replace(/'/g, `'\\''`)}'`;
}

export function validateSetupManifest(
  manifest: SetupManifest,
): SetupValidationResult {
  const errors: string[] = [];
  const require = (value: unknown, label: string) => {
    if (typeof value !== "string" || !value.trim()) {
      errors.push(`${label} is required.`);
    }
  };

  require(manifest.project.name, "Project name");
  require(manifest.services.gemini_api_key, "Gemini API key");
  require(manifest.services.firecrawl_api_key, "Firecrawl API key");
  require(manifest.services.apify_api_token, "Apify API token");
  require(manifest.services.resend_api_key, "Resend API key");
  require(manifest.services.resend_from_email, "Resend sender email");
  require(manifest.services.public_maptiler_api_key, "MapTiler API key");
  require(manifest.auth.admin_email, "Admin email");
  if (!manifest.auth.admin_email.includes("@")) {
    errors.push("Admin email must be an email address.");
  }
  if (manifest.auth.signup_allowed_domains.length === 0) {
    errors.push("At least one signup domain is required.");
  }

  if (manifest.supabase.mode === "cloud-create") {
    require(manifest.supabase.org_id, "Supabase organization ID");
    require(manifest.supabase.region, "Supabase region");
    require(manifest.supabase.db_password, "Supabase database password");
    require(manifest.supabase.access_token, "Supabase access token");
  }
  if (manifest.supabase.mode === "cloud-existing") {
    require(manifest.supabase.project_ref, "Supabase project ref");
    require(manifest.supabase.project_url, "Supabase project URL");
    require(manifest.supabase.anon_key, "Supabase anon key");
    require(manifest.supabase.service_role_key, "Supabase service role key");
    require(manifest.supabase.jwt_secret, "Supabase JWT secret");
    require(manifest.supabase.access_token, "Supabase access token");
  }
  if (manifest.supabase.mode === "self-hosted") {
    require(manifest.supabase.project_url, "Self-hosted Supabase URL");
    require(manifest.supabase.anon_key, "Self-hosted Supabase anon key");
    require(
      manifest.supabase.service_role_key,
      "Self-hosted Supabase service role key",
    );
    require(manifest.supabase.jwt_secret, "Self-hosted Supabase JWT secret");
  }

  return { valid: errors.length === 0, errors };
}

export function deriveAgentTargetFromManifest(
  manifest: SetupManifest,
): AgentTargetContext {
  const appUrl = trimSlash(
    manifest.project.app_url || manifest.frontend.production_url ||
      "https://<your-frontend-domain>",
  );
  const supabaseUrl = trimSlash(manifest.supabase.project_url || "");
  const customMcpUrl = manifest.agents.custom_mcp_url
    ? trimSlash(manifest.agents.custom_mcp_url)
    : "";
  return {
    deploymentKind: "supabase",
    appUrl,
    apiBaseUrl: `${
      supabaseUrl || "https://<project-ref>.supabase.co"
    }/functions/v1`,
    mcpUrl: customMcpUrl ||
      `${
        supabaseUrl || "https://<project-ref>.supabase.co"
      }/functions/v1/mcp-server`,
    skillUrl: `${appUrl}/skills/cojournalist.md`,
    apiKeyCreateUrl: appUrl,
    supabaseAnonKey: manifest.supabase.anon_key || "<SUPABASE_ANON_KEY>",
    customMcpUrl: customMcpUrl || undefined,
  };
}

export function redactSetupManifest<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactSetupManifest(item)) as T;
  }
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEYS.has(key) && typeof child === "string" && child) {
      out[key] = `${child.slice(0, 4)}…redacted`;
    } else {
      out[key] = redactSetupManifest(child);
    }
  }
  return out as T;
}

export function buildAgentManifestPrompt(
  manifestPath = "scoutpost-setup.json",
): string {
  return [
    "Deploy this newsroom-owned Scoutpost instance from the local setup manifest.",
    "Do not ask me to paste secrets into chat.",
    `Read ${manifestPath} from disk and validate that it is version 1. Treat that file as the only source of deployment secrets and configuration.`,
    "If scoutpost-docker-install.sh is present beside the manifest, run bash scoutpost-docker-install.sh install for initial setup, bash scoutpost-docker-install.sh doctor for validation, and bash scoutpost-docker-install.sh update for downstream maintenance PRs.",
    `Prefer the Docker installer when Docker is available: run ${DOCKER_INSTALLER_IMAGE}, mount the deployment directory or repository at /workspace, mount the manifest read-only at /config/scoutpost-setup.json, and run install.`,
    "If the prebuilt installer image is unavailable, build deploy/installer/Dockerfile from the Scoutpost repository root and use the local scoutpost-installer image instead.",
    "If Docker is unavailable, run automation/setup-from-manifest.sh with the manifest path from the Scoutpost repository root.",
    "For Supabase Cloud, use the manifest supabase.access_token for non-interactive Supabase CLI authentication. Do not run browser login inside Docker.",
    "Do not print, summarize, cat, or paste secret values from the manifest. It is acceptable to report missing field names and redacted previews only.",
    "Install the upstream sync workflow by default so this fork can receive Scoutpost OSS maintenance updates.",
    "After setup, run the Docker doctor path or automation/selfhost-doctor.sh, verify .github/workflows/sync-upstream.yml exists, and tell the operator which GitHub secrets are available for maintenance reporting.",
    "For future downstream updates, use the Docker installer update command from the same mounted repository so the update PR is prepared in a repeatable operator environment.",
    "Use the Supabase project URL, API base, MCP URL, and skill URL from the manifest-generated deployment only.",
    "Do not connect CLI, MCP, or REST clients to scoutpost.ai unless the manifest explicitly says this is the hosted SaaS.",
  ].join("\n");
}

export function buildDockerInstallerInstructions(
  manifestPath = "scoutpost-setup.json",
): string {
  return `# Scoutpost Docker installer

This is the recommended self-host setup path. The easiest route is to keep this file beside scoutpost-docker-install.sh and run:

\`\`\`bash
bash scoutpost-docker-install.sh install
\`\`\`

That script pulls the prebuilt installer image when available and builds the same image locally from Scoutpost OSS if the registry image cannot be pulled. The container runs the manifest installer in a disposable operator environment so Node, Deno, Supabase CLI, GitHub CLI, jq, and OpenSSL do not need to be installed directly on the host.

The manifest is the source of truth. Keep it on disk, mount it read-only, and do not paste it into chat.

Expected local files:

- ./${manifestPath}

The prebuilt image clones Scoutpost OSS into /workspace/scoutpost-os if /workspace is not already a checkout. For downstream update PRs, mount the newsroom fork checkout as /workspace.

## Initial install

Run from the directory that contains ${manifestPath}:

\`\`\`bash
docker run --rm -it \\
  -v "$PWD:/workspace" \\
  -v "$PWD/${manifestPath}:/config/scoutpost-setup.json:ro" \\
  ${DOCKER_INSTALLER_IMAGE} install
\`\`\`

## Read-only validation

\`\`\`bash
docker run --rm -it \\
  -v "$PWD:/workspace" \\
  -v "$PWD/${manifestPath}:/config/scoutpost-setup.json:ro" \\
  ${DOCKER_INSTALLER_IMAGE} doctor
\`\`\`

## Downstream updates

Run this from the downstream newsroom fork checkout when you want to pull current Scoutpost OSS updates into a reviewable PR:

\`\`\`bash
docker run --rm -it \\
  -v "$PWD:/workspace" \\
  -v "$HOME/.config/gh:/root/.config/gh:ro" \\
  -v "$PWD/${manifestPath}:/config/scoutpost-setup.json:ro" \\
  ${DOCKER_INSTALLER_IMAGE} update
\`\`\`

The update command fetches upstream, prepares a maintenance branch, refreshes the sync workflow, runs doctor before and after the merge, and opens a PR when GitHub CLI auth is mounted.

## Local image fallback

If the prebuilt image is unavailable, run these commands from a Scoutpost checkout:

\`\`\`bash
docker build -f deploy/installer/Dockerfile -t scoutpost-installer .
docker run --rm -it \\
  -v "$PWD:/workspace" \\
  -v "$PWD/${manifestPath}:/config/scoutpost-setup.json:ro" \\
  scoutpost-installer install
\`\`\`

Do not paste ${manifestPath} into chat. It contains local deployment credentials and should stay on disk.
`;
}

export function buildDockerInstallerScript(
  manifestPath = "scoutpost-setup.json",
): string {
  return `#!/usr/bin/env bash
set -euo pipefail

COMMAND="\${1:-install}"
IMAGE="\${SCOUTPOST_INSTALLER_IMAGE:-\${COJOURNALIST_INSTALLER_IMAGE:-${DOCKER_INSTALLER_IMAGE}}}"
LOCAL_IMAGE="\${SCOUTPOST_LOCAL_INSTALLER_IMAGE:-\${COJOURNALIST_LOCAL_INSTALLER_IMAGE:-scoutpost-installer:local}}"
WORKSPACE="\${SCOUTPOST_WORKSPACE:-\${COJOURNALIST_WORKSPACE:-$PWD}}"
MANIFEST="\${SCOUTPOST_SETUP_MANIFEST:-\${COJOURNALIST_SETUP_MANIFEST:-$WORKSPACE/${manifestPath}}}"
UPSTREAM_REPO="\${SCOUTPOST_UPSTREAM_REPO:-\${COJOURNALIST_UPSTREAM_REPO:-https://github.com/buriedsignals/scoutpost-os.git}}"

log() { printf "\\n== %s ==\\n" "$1" >&2; }
warn() { printf "WARN: %s\\n" "$1" >&2; }

case "$COMMAND" in
  install|doctor|update) ;;
  *)
    echo "Usage: $0 {install|doctor|update}" >&2
    exit 2
    ;;
esac

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker Desktop or Docker Engine is required." >&2
  echo "Install Docker, start it, then rerun this script." >&2
  exit 1
fi

mkdir -p "$WORKSPACE"

if [ "$COMMAND" = "install" ] && [ ! -f "$MANIFEST" ]; then
  echo "Setup manifest not found: $MANIFEST" >&2
  echo "Put ${manifestPath} next to this script, or set SCOUTPOST_SETUP_MANIFEST=/path/to/${manifestPath}." >&2
  exit 2
fi

find_build_repo() {
  if [ -f "$WORKSPACE/deploy/installer/Dockerfile" ]; then
    printf "%s" "$WORKSPACE"
    return 0
  fi
  if [ -f "$WORKSPACE/scoutpost-os/deploy/installer/Dockerfile" ]; then
    printf "%s" "$WORKSPACE/scoutpost-os"
    return 0
  fi

  if ! command -v git >/dev/null 2>&1; then
    echo "The prebuilt installer image was unavailable, and git is required for the local-build fallback." >&2
    echo "Install git or rerun after the GHCR image is public/readable." >&2
    exit 1
  fi

  log "Clone Scoutpost OSS for local installer image fallback"
  git clone "$UPSTREAM_REPO" "$WORKSPACE/scoutpost-os"
  printf "%s" "$WORKSPACE/scoutpost-os"
}

select_image() {
  if docker image inspect "$IMAGE" >/dev/null 2>&1; then
    printf "%s" "$IMAGE"
    return 0
  fi

  log "Pull installer image"
  if docker pull "$IMAGE" >&2; then
    printf "%s" "$IMAGE"
    return 0
  fi

  warn "Could not pull $IMAGE; building a local installer image instead."
  local build_repo
  build_repo="$(find_build_repo)"
  log "Build local installer image"
  docker build -f "$build_repo/deploy/installer/Dockerfile" -t "$LOCAL_IMAGE" "$build_repo" >&2
  printf "%s" "$LOCAL_IMAGE"
}

RUN_IMAGE="$(select_image)"

docker_args=(run --rm)
if [ -t 0 ] && [ -t 1 ]; then
  docker_args+=(-it)
fi
docker_args+=(-v "$WORKSPACE:/workspace")
if [ -f "$MANIFEST" ]; then
  docker_args+=(-v "$MANIFEST:/config/scoutpost-setup.json:ro")
fi
if [ "$COMMAND" = "update" ] && [ -d "$HOME/.config/gh" ]; then
  docker_args+=(-v "$HOME/.config/gh:/root/.config/gh:ro")
fi
docker_args+=("$RUN_IMAGE" "$COMMAND")

log "Run Scoutpost installer: $COMMAND"
docker "\${docker_args[@]}"
`;
}

export function buildInstallScript(manifest: SetupManifest): string {
  const manifestJson = JSON.stringify(manifest, null, 2);
  return `#!/usr/bin/env bash
set -euo pipefail

MANIFEST_PATH="\${SCOUTPOST_SETUP_MANIFEST:-\${COJOURNALIST_SETUP_MANIFEST:-}}"
if [ -z "$MANIFEST_PATH" ]; then
  MANIFEST_PATH="$(mktemp "\${TMPDIR:-/tmp}/scoutpost-setup.XXXXXX.json")"
  cat > "$MANIFEST_PATH" <<'SCOUTPOST_MANIFEST_JSON'
${manifestJson}
SCOUTPOST_MANIFEST_JSON
  chmod 600 "$MANIFEST_PATH"
fi

if ! command -v git >/dev/null 2>&1; then
  echo "git is required before setup can continue." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/automation/setup-from-manifest.sh" ]; then
  bash "$SCRIPT_DIR/automation/setup-from-manifest.sh" "$MANIFEST_PATH"
  exit 0
fi

WORK_DIR="\${SCOUTPOST_SETUP_WORK_DIR:-\${COJOURNALIST_SETUP_WORK_DIR:-\${TMPDIR:-/tmp}/scoutpost-setup-work}}"
REPO_DIR="$WORK_DIR/scoutpost-os"
mkdir -p "$WORK_DIR"
if [ -d "$REPO_DIR/.git" ]; then
  git -C "$REPO_DIR" fetch origin master
  git -C "$REPO_DIR" checkout master
  git -C "$REPO_DIR" pull --ff-only origin master
else
  git clone https://github.com/buriedsignals/scoutpost-os.git "$REPO_DIR"
  git -C "$REPO_DIR" checkout master
fi

bash "$REPO_DIR/automation/setup-from-manifest.sh" "$MANIFEST_PATH"
`;
}

export function buildNewsroomOnboarding(manifest: SetupManifest): string {
  const target = deriveAgentTargetFromManifest(manifest);
  const domains = manifest.auth.signup_allowed_domains.map((domain) =>
    `@${domain}`
  ).join(", ");
  const appUrl = target.appUrl;
  return `# Scoutpost newsroom guide

Scoutpost watches websites, beats, social accounts, and civic pages for us. It saves possible story leads with source links.

## Start here

1. Open ${appUrl}
2. Sign up with your newsroom email.
3. Your email must end with: ${domains}

If sign-up does not work, contact ${manifest.auth.admin_email}.

## Make a scout

Choose the scout that matches what you want to watch:

- Page Scout: one page, like a school board agenda page.
- Beat Scout: a topic or place, like housing in Riverside.
- Social Scout: public social accounts.
- Civic Scout: council agendas, minutes, PDFs, and meeting pages.

Start small. A narrow scout is easier to trust than a broad one.

## Use ChatGPT with Scoutpost

If you use ChatGPT in the browser, the simplest workflow is:

1. Open Scoutpost.
2. Open a scout result or your inbox.
3. Copy the source-linked notes or export from Scoutpost.
4. Paste that material into ChatGPT.
5. Ask ChatGPT to help draft questions, organize leads, or prepare a brief.

Do not paste private API keys into ChatGPT.

## If your AI assistant supports tools

Some assistants can connect directly to Scoutpost. If yours can, open Scoutpost and click Agents. That screen will show the latest setup steps for your newsroom.

You can also give your assistant this prompt:

\`\`\`text
I use my newsroom's Scoutpost at ${appUrl}.

Please help me connect to it.

First, load the Scoutpost skill from:
${target.skillUrl}

Then use the newsroom's own connection details:
- MCP: ${target.mcpUrl}
- API: ${target.apiBaseUrl}

Do not connect to scoutpost.ai.

If you need an API key, tell me to open Scoutpost, click Agents, open API, and create a key there. Do not ask me to paste a key into chat.
\`\`\`

## Prompts you can use in ChatGPT

- "Turn these Scoutpost leads into a short story memo. Keep every source link."
- "Group these leads by theme and tell me what to verify next."
- "Draft five interview questions based only on these notes."
- "What is the strongest local angle in these leads?"
- "Make a checklist of facts I need to confirm before publication."
- "Rewrite this as a concise editor update, but keep it clear that these are unverified leads."

## Editorial reminders

- Scoutpost gives leads, not finished facts.
- Open the source links.
- Verify before publishing.
- Keep source links in drafts and briefs.
- If two sources conflict, say so.

## Need help?

Contact ${manifest.auth.admin_email}.
`;
}

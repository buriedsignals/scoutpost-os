function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertIncludes(haystack: string, needle: string, context = "output") {
  assert(
    haystack.includes(needle),
    `Expected ${context} to include ${JSON.stringify(needle)}.\n\n${haystack}`,
  );
}

function assertNotIncludes(
  haystack: string,
  needle: string,
  context = "output",
) {
  assert(
    !haystack.includes(needle),
    `Expected ${context} not to include ${
      JSON.stringify(needle)
    }.\n\n${haystack}`,
  );
}

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const doctorScript = `${repoRoot}/selfhost/selfhost-doctor.sh`;
const manifestSetupScript = `${repoRoot}/selfhost/setup-from-manifest.sh`;
const adoptScript = `${repoRoot}/selfhost/adopt-signup-allowlist.sh`;
const workflowPath = `${repoRoot}/selfhost/sync-upstream.yml`;
const dockerMigrationScript = `${repoRoot}/deploy/docker/run-app-migrations.sh`;
const hostedSupabaseRef = "gfmdziplticfoak" + "hrfpt";

async function run(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const output = await new Deno.Command(command, {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();

  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

async function initRepo(path: string) {
  await Deno.mkdir(path, { recursive: true });
  await run("git", ["init"], path);
  await run("git", ["config", "user.name", "Test User"], path);
  await run("git", ["config", "user.email", "test@example.com"], path);
  await Deno.mkdir(`${path}/supabase/migrations`, { recursive: true });
}

Deno.test("selfhost doctor finds a nested checkout", async () => {
  const tmp = await Deno.makeTempDir();
  const repo = `${tmp}/scoutpost-os`;
  await initRepo(repo);
  await Deno.writeTextFile(
    `${repo}/supabase/config.toml`,
    `[auth.hook.before_user_created]
enabled = true
uri = "pg-functions://postgres/public/hook_restrict_signup_by_allowlist"
`,
  );

  const result = await run("bash", [doctorScript], tmp);

  assert(result.code === 0, result.stderr || result.stdout);
  assertIncludes(result.stdout, "nested checkout", "doctor stdout");
  assertIncludes(result.stdout, repo, "doctor stdout");
});

Deno.test("selfhost doctor reports dirty files, untracked migrations, and custom auth hooks", async () => {
  const tmp = await Deno.makeTempDir();
  await initRepo(tmp);
  await Deno.writeTextFile(`${tmp}/README.md`, "initial\n");
  await run("git", ["add", "README.md"], tmp);
  await run("git", ["commit", "-m", "initial"], tmp);
  await Deno.writeTextFile(`${tmp}/README.md`, "changed\n");
  await Deno.writeTextFile(
    `${tmp}/supabase/migrations/00048_local.sql`,
    "select 1;\n",
  );
  await Deno.writeTextFile(
    `${tmp}/supabase/config.toml`,
    `[auth.hook.before_user_created]
enabled = true
uri = "pg-functions://postgres/public/hook_restrict_signup_to_meier_domain"
`,
  );

  const result = await run("bash", [doctorScript], tmp);

  assert(result.code === 0, result.stderr || result.stdout);
  assertIncludes(result.stdout, "Working tree changes:", "doctor stdout");
  assertIncludes(
    result.stdout,
    "Untracked Supabase migrations:",
    "doctor stdout",
  );
  assertIncludes(result.stdout, "00048_local.sql", "doctor stdout");
  assertIncludes(
    result.stdout,
    "Custom Supabase signup hook detected",
    "doctor stdout",
  );
});

Deno.test("selfhost doctor passes generated newsroom Supabase config", async () => {
  const tmp = await Deno.makeTempDir();
  await initRepo(tmp);
  await Deno.mkdir(`${tmp}/frontend`, { recursive: true });
  await Deno.writeTextFile(
    `${tmp}/.env`,
    "SUPABASE_URL=https://newsroom-project.supabase.co\n",
  );
  await Deno.writeTextFile(
    `${tmp}/frontend/.env.production.local`,
    [
      "PUBLIC_DEPLOYMENT_TARGET=supabase",
      "PUBLIC_SUPABASE_URL=https://newsroom-project.supabase.co",
      "PUBLIC_SUPABASE_ANON_KEY=anon_test",
      "VITE_API_URL=https://newsroom-project.supabase.co/functions/v1",
      "PUBLIC_LOCAL_DEMO_MODE=false",
      "",
    ].join("\n"),
  );
  await Deno.writeTextFile(
    `${tmp}/supabase/config.toml`,
    `[auth.hook.before_user_created]
enabled = true
uri = "pg-functions://postgres/public/hook_restrict_signup_by_allowlist"
`,
  );

  const result = await run("bash", [doctorScript], tmp);

  assert(result.code === 0, result.stderr || result.stdout);
  assertIncludes(result.stdout, "No blocking issues found", "doctor stdout");
});

Deno.test("selfhost doctor blocks hosted Supabase refs in frontend env", async () => {
  const tmp = await Deno.makeTempDir();
  await initRepo(tmp);
  await Deno.mkdir(`${tmp}/frontend`, { recursive: true });
  await Deno.writeTextFile(
    `${tmp}/frontend/.env.production`,
    `PUBLIC_SUPABASE_URL=https://${hostedSupabaseRef}.supabase.co\n`,
  );

  const result = await run("bash", [doctorScript], tmp);

  assert(result.code !== 0, "hosted Supabase ref should block doctor");
  assertIncludes(
    result.stdout,
    "Hosted Scoutpost Supabase project ref found",
    "doctor stdout",
  );
});

Deno.test("selfhost doctor blocks hosted Supabase refs in local frontend env", async () => {
  const tmp = await Deno.makeTempDir();
  await initRepo(tmp);
  await Deno.mkdir(`${tmp}/frontend`, { recursive: true });
  await Deno.writeTextFile(
    `${tmp}/frontend/.env.production.local`,
    `PUBLIC_SUPABASE_URL=https://${hostedSupabaseRef}.supabase.co\n`,
  );

  const result = await run("bash", [doctorScript], tmp);

  assert(result.code !== 0, "hosted Supabase ref should block doctor");
  assertIncludes(
    result.stdout,
    "Hosted Scoutpost Supabase project ref found",
    "doctor stdout",
  );
});

Deno.test("selfhost doctor blocks root/frontend Supabase URL mismatch", async () => {
  const tmp = await Deno.makeTempDir();
  await initRepo(tmp);
  await Deno.mkdir(`${tmp}/frontend`, { recursive: true });
  await Deno.writeTextFile(
    `${tmp}/.env`,
    "SUPABASE_URL=https://root-project.supabase.co\n",
  );
  await Deno.writeTextFile(
    `${tmp}/frontend/.env.production`,
    [
      "PUBLIC_SUPABASE_URL=https://frontend-project.supabase.co",
      "VITE_API_URL=https://frontend-project.supabase.co/functions/v1",
      "",
    ].join("\n"),
  );

  const result = await run("bash", [doctorScript], tmp);

  assert(result.code !== 0, "mismatched Supabase URLs should block doctor");
  assertIncludes(
    result.stdout,
    "does not match frontend/.env.production PUBLIC_SUPABASE_URL",
    "doctor stdout",
  );
});

Deno.test("adopt signup allowlist dry-run prints idempotent SQL without Supabase execution", async () => {
  const tmp = await Deno.makeTempDir();
  const result = await run("bash", [
    adoptScript,
    "--domain",
    "Meier.CH",
    "--admin",
    "Editor@Meier.CH",
    "--project-ref",
    "projectref",
    "--dry-run",
  ], tmp);

  assert(result.code === 0, result.stderr || result.stdout);
  assertIncludes(result.stdout, "editor@meier.ch", "adopt stdout");
  assertIncludes(result.stdout, "meier.ch", "adopt stdout");
  assertIncludes(
    result.stdout,
    "on conflict (kind, value) do update",
    "adopt stdout",
  );
  assertIncludes(
    result.stdout,
    "supabase config push --project-ref projectref",
    "adopt stdout",
  );
  assertNotIncludes(result.stdout, "truncate", "adopt stdout");
});

Deno.test("adopt signup allowlist validates required inputs", async () => {
  const tmp = await Deno.makeTempDir();
  const missingDomain = await run("bash", [
    adoptScript,
    "--admin",
    "editor@example.com",
    "--project-ref",
    "projectref",
    "--dry-run",
  ], tmp);
  assert(missingDomain.code !== 0, "missing domain should fail");
  assertIncludes(missingDomain.stderr, "--domain is required", "adopt stderr");

  const invalidEmail = await run("bash", [
    adoptScript,
    "--domain",
    "example.com",
    "--admin",
    "not-an-email",
    "--project-ref",
    "projectref",
    "--dry-run",
  ], tmp);
  assert(invalidEmail.code !== 0, "invalid email should fail");
  assertIncludes(invalidEmail.stderr, "Invalid admin email", "adopt stderr");
});

Deno.test("sync workflow is PR-based and does not apply database changes", async () => {
  const workflow = await Deno.readTextFile(workflowPath);

  assertIncludes(workflow, "gh pr create", "workflow");
  assertIncludes(workflow, "upstream_commit", "workflow");
  assertIncludes(workflow, "migration_files", "workflow");
  assertNotIncludes(workflow, "git push origin master", "workflow");
  assertNotIncludes(workflow, "supabase db push", "workflow");
});

Deno.test("manifest setup does not run interactive Firecrawl browser auth by default", async () => {
  const script = await Deno.readTextFile(manifestSetupScript);

  assertIncludes(script, "COJOURNALIST_INSTALL_AGENT_TOOLING", "setup script");
  assertIncludes(
    script,
    "Skipping optional local CLI installs",
    "setup script",
  );
  assertNotIncludes(
    script,
    "firecrawl-cli@latest init --all --browser",
    "setup script",
  );
});

Deno.test("manifest setup uses Supabase access token instead of browser login", async () => {
  const script = await Deno.readTextFile(manifestSetupScript);

  assertIncludes(script, "MANIFEST_SUPABASE_ACCESS_TOKEN", "setup script");
  assertIncludes(script, "export SUPABASE_ACCESS_TOKEN", "setup script");
  assertIncludes(script, "supabase.access_token", "setup script");
  assertNotIncludes(script, "$SUPABASE_CLI login", "setup script");
});

Deno.test("manifest v1 requires an OpenRouter key with an actionable upgrade error", async () => {
  const tmp = await Deno.makeTempDir();
  const manifest = `${tmp}/scoutpost-setup.json`;
  await Deno.writeTextFile(
    manifest,
    JSON.stringify({
      version: 1,
      services: { gemini_api_key: "legacy-direct-key" },
    }),
  );

  const result = await run("bash", [manifestSetupScript, manifest], tmp);

  assert(result.code !== 0, "Gemini-only v1 manifest should fail");
  assertIncludes(
    result.stderr,
    "Manifest version 1 is Gemini-only",
    "setup stderr",
  );
  assertIncludes(result.stderr, "services.openrouter_api_key", "setup stderr");
  assertIncludes(result.stderr, "version 2 manifest", "setup stderr");
});

Deno.test("manifest v2 rejects the removed Gemini field", async () => {
  const tmp = await Deno.makeTempDir();
  const manifest = `${tmp}/scoutpost-setup.json`;
  await Deno.writeTextFile(
    manifest,
    JSON.stringify({
      version: 2,
      services: {
        openrouter_api_key: "openrouter-secret",
        gemini_api_key: "legacy-direct-key",
      },
    }),
  );

  const result = await run("bash", [manifestSetupScript, manifest], tmp);

  assert(result.code !== 0, "v2 manifest with Gemini field should fail");
  assertIncludes(
    result.stderr,
    "version 2 must not contain services.gemini_api_key",
    "setup stderr",
  );
  assertIncludes(result.stderr, "single AI credential", "setup stderr");
});

Deno.test("example v2 manifest contains exactly one AI key", async () => {
  const example = JSON.parse(
    await Deno.readTextFile(
      `${repoRoot}/deploy/installer/scoutpost-setup.example.json`,
    ),
  );
  const aiKeys = Object.keys(example.services).filter((key) =>
    /(?:gemini|openrouter)_api_key/.test(key)
  );

  assert(example.version === 2, "example manifest should use version 2");
  assert(
    aiKeys.length === 1,
    `expected one AI key, found: ${aiKeys.join(", ")}`,
  );
  assert(
    aiKeys[0] === "openrouter_api_key",
    "OpenRouter should be the only AI key",
  );
});

Deno.test("runtime setup wiring uses one OpenRouter key and full model IDs", async () => {
  const paths = [
    ".env.example",
    "docker-compose.yml",
    "render.yaml",
    "deploy/docker/.env.example",
    "deploy/docker/docker-compose.yml",
    "deploy/render/render.yaml",
    "selfhost/setup.sh",
  ];

  for (const path of paths) {
    const content = await Deno.readTextFile(`${repoRoot}/${path}`);
    assertIncludes(content, "OPENROUTER_API_KEY", path);
    assertNotIncludes(content, "GEMINI_API_KEY", path);
  }

  const modelFiles = [
    ".env.example",
    "docker-compose.yml",
    "deploy/docker/.env.example",
    "deploy/docker/docker-compose.yml",
    "deploy/render/render.yaml",
    "selfhost/setup.sh",
  ];
  for (const path of modelFiles) {
    const content = await Deno.readTextFile(`${repoRoot}/${path}`);
    assertIncludes(content, "google/gemini-2.5-flash-lite", path);
  }
});

Deno.test("setup provisions Edge secrets before deploying functions", async () => {
  const manifestScript = await Deno.readTextFile(manifestSetupScript);
  const manifestCalls = manifestScript.slice(
    manifestScript.lastIndexOf("\ninstall_node_tooling\n"),
  );
  assert(
    manifestCalls.indexOf("\nset_supabase_secrets\n") <
      manifestCalls.indexOf("\ndeploy_edge_functions\n"),
    "manifest setup must set secrets before function deployment",
  );

  const interactiveScript = await Deno.readTextFile(
    `${repoRoot}/selfhost/setup.sh`,
  );
  const setupStart = interactiveScript.indexOf("setup_supabase_managed() {");
  const setupEnd = interactiveScript.indexOf(
    "setup_supabase_selfhosted() {",
    setupStart,
  );
  const managedSetup = interactiveScript.slice(setupStart, setupEnd);
  assert(
    managedSetup.indexOf("$SUPABASE_CLI secrets set") <
      managedSetup.indexOf("$SUPABASE_CLI functions deploy"),
    "interactive setup must set secrets before function deployment",
  );
  assertNotIncludes(
    managedSetup,
    "functions deploy --all",
    "interactive setup",
  );
  assertIncludes(
    interactiveScript,
    "LLM_MODEL must use the google/ namespace",
    "interactive setup",
  );
});

Deno.test("setup guidance uses the supported deploy-all function syntax", async () => {
  const paths = [
    "deploy/SETUP.md",
    "docs/oss/self-hosting-automation.md",
    "selfhost/SETUP_AGENT.md",
    "selfhost/SKILL.md",
    "selfhost/selfhost-doctor.sh",
    "selfhost/setup-from-manifest.sh",
    "selfhost/setup.sh",
    "selfhost/upstream-maintenance-codex-prompt.txt",
  ];

  for (const path of paths) {
    const content = await Deno.readTextFile(`${repoRoot}/${path}`);
    assertNotIncludes(content, "functions deploy --all", path);
    assertIncludes(content, "functions deploy", path);
  }
});

Deno.test("Docker migration runner applies every migration once in order", async () => {
  const compose = await Deno.readTextFile(
    `${repoRoot}/deploy/docker/docker-compose.yml`,
  );
  assertIncludes(
    compose,
    "./run-app-migrations.sh:/run-app-migrations.sh:ro",
    "Docker Compose",
  );
  assertIncludes(
    compose,
    "condition: service_completed_successfully",
    "Docker Compose",
  );
  assertNotIncludes(
    compose,
    "/migrations/00002_tables.sql /migrations/00003_indexes.sql",
    "Docker Compose",
  );

  const tmp = await Deno.makeTempDir();
  const migrations = `${tmp}/migrations`;
  const state = `${tmp}/state`;
  const logPath = `${tmp}/psql.log`;
  const fakePsql = `${tmp}/psql`;
  await Deno.mkdir(migrations);
  await Deno.mkdir(state);
  for (
    const name of [
      "00001_first.sql",
      "00002_second.sql",
      "00010_last.sql",
    ]
  ) {
    await Deno.writeTextFile(`${migrations}/${name}`, "SELECT 1;\n");
  }
  await Deno.writeTextFile(
    fakePsql,
    `#!/bin/sh
set -eu
input="$(cat)"
printf '%s\\n%s\\n' "$*" "$input" >> "$PSQL_LOG"
version=""
for arg in "$@"; do
  case "$arg" in
    version=*) version="\${arg#version=}" ;;
  esac
done
case "$* $input" in
  *"to_regclass('auth.users')"*) printf 't\\n' ;;
  *"SELECT EXISTS"*)
    if [ -f "$PSQL_STATE_DIR/$version" ]; then printf 't\\n'; else printf 'f\\n'; fi
    ;;
  *"INSERT INTO supabase_migrations.schema_migrations"*)
    touch "$PSQL_STATE_DIR/$version"
    ;;
esac
`,
  );
  await Deno.chmod(fakePsql, 0o755);

  const env = {
    MIGRATIONS_DIR: migrations,
    PSQL_BIN: fakePsql,
    PSQL_LOG: logPath,
    PSQL_STATE_DIR: state,
    MIGRATION_WAIT_SECONDS: "0",
    POSTGRES_PASSWORD: "test-password",
  };
  const first = await new Deno.Command("bash", {
    args: [dockerMigrationScript],
    cwd: repoRoot,
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(first.code === 0, new TextDecoder().decode(first.stderr));
  const firstStdout = new TextDecoder().decode(first.stdout);
  assertIncludes(firstStdout, "Applying 00001_first.sql", "first run");
  assertIncludes(firstStdout, "Applying 00002_second.sql", "first run");
  assertIncludes(firstStdout, "Applying 00010_last.sql", "first run");

  const second = await new Deno.Command("bash", {
    args: [dockerMigrationScript],
    cwd: repoRoot,
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(second.code === 0, new TextDecoder().decode(second.stderr));
  const secondStdout = new TextDecoder().decode(second.stdout);
  assertIncludes(secondStdout, "Skipping 00001_first.sql", "second run");
  assertIncludes(secondStdout, "Skipping 00002_second.sql", "second run");
  assertIncludes(secondStdout, "Skipping 00010_last.sql", "second run");

  const psqlLog = await Deno.readTextFile(logPath);
  for (
    const name of [
      "00001_first.sql",
      "00002_second.sql",
      "00010_last.sql",
    ]
  ) {
    const applied = psqlLog.split("\n").filter((line) =>
      line.includes(`-f ${migrations}/${name}`)
    );
    assert(applied.length === 1, `${name} should be applied exactly once`);
  }
});

Deno.test("manifest setup manual provider writes porting packet without Supabase execution", async () => {
  const tmp = await Deno.makeTempDir();
  await Deno.mkdir(`${tmp}/frontend`, { recursive: true });
  await Deno.mkdir(`${tmp}/supabase/functions`, { recursive: true });
  await Deno.mkdir(`${tmp}/supabase/migrations`, { recursive: true });
  const manifest = {
    version: 1,
    project: {
      name: "manual-newsroom",
      app_url: "https://newsroom.example.com",
    },
    services: {
      openrouter_api_key: "openrouter-secret",
      firecrawl_api_key: "firecrawl-secret",
      apify_api_token: "apify-secret",
      resend_api_key: "resend-secret",
      resend_from_email: "scouts@example.com",
      public_maptiler_api_key: "maptiler-secret",
    },
    auth: {
      admin_email: "admin@example.com",
      signup_allowed_domains: ["example.com"],
    },
    data_platform: {
      provider: "manual",
      provider_name: "Internal platform",
      integration_mode: "manual",
      docs_urls: ["https://platform.example.com/docs"],
      operator_notes: "Use company auth and approved managed Postgres.",
    },
    supabase: { mode: "cloud-create" },
    frontend: {
      provider: "manual",
      production_url: "https://newsroom.example.com",
    },
    agents: {
      install_firecrawl_skill: true,
      install_supabase_skill: false,
      install_render_skill: false,
    },
    options: {
      include_fastapi_addon: false,
      install_sync_workflow: false,
    },
  };
  await Deno.writeTextFile(
    `${tmp}/scoutpost-setup.json`,
    JSON.stringify(manifest),
  );

  const result = await run("bash", [
    manifestSetupScript,
    `${tmp}/scoutpost-setup.json`,
  ], tmp);
  const packet = await Deno.readTextFile(
    `${tmp}/scoutpost-provider-porting.md`,
  );

  assert(result.code === 0, result.stderr || result.stdout);
  assertIncludes(result.stdout, "Manual provider packet", "setup stdout");
  assertIncludes(
    result.stdout,
    "does not run Supabase CLI commands",
    "setup stdout",
  );
  assertIncludes(packet, "Provider: Internal platform", "provider packet");
  assertIncludes(
    packet,
    "Migration index: docs/supabase/migrations.md",
    "provider packet",
  );
  assertIncludes(
    packet,
    "Migration directory: supabase/migrations/",
    "provider packet",
  );
  assertNotIncludes(result.stdout, "supabase db push", "setup stdout");
});

Deno.test("generated self-host setup artifacts are gitignored", async () => {
  const artifacts = [
    "scoutpost-setup.json",
    "scoutpost-install.sh",
    "scoutpost-agent-prompt.md",
    "scoutpost-provider-porting.md",
    "scoutpost-docker-install.md",
    "scoutpost-docker-install.sh",
    "newsroom-onboarding.md",
  ];

  const result = await run(
    "git",
    ["check-ignore", "-v", ...artifacts],
    repoRoot,
  );

  assert(result.code === 0, result.stderr || result.stdout);
  for (const artifact of artifacts) {
    assertIncludes(result.stdout, artifact, "git check-ignore output");
  }
});

Deno.test("Supabase migration versions are unique", async () => {
  const versions = new Map<string, string[]>();
  for await (const entry of Deno.readDir(`${repoRoot}/supabase/migrations`)) {
    if (!entry.isFile || !entry.name.endsWith(".sql")) continue;
    const version = entry.name.match(/^(\d+)_/)?.[1];
    if (!version) continue;
    versions.set(version, [...(versions.get(version) ?? []), entry.name]);
  }

  const duplicates = [...versions.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([version, files]) => `${version}: ${files.sort().join(", ")}`);

  assert(
    duplicates.length === 0,
    `Duplicate Supabase migration versions:\n${duplicates.join("\n")}`,
  );
});

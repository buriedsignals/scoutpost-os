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
const doctorScript = `${repoRoot}/automation/selfhost-doctor.sh`;
const manifestSetupScript = `${repoRoot}/automation/setup-from-manifest.sh`;
const adoptScript = `${repoRoot}/automation/adopt-signup-allowlist.sh`;
const workflowPath = `${repoRoot}/automation/sync-upstream.yml`;
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

Deno.test("generated self-host setup artifacts are gitignored", async () => {
  const artifacts = [
    "scoutpost-setup.json",
    "scoutpost-install.sh",
    "scoutpost-agent-prompt.md",
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

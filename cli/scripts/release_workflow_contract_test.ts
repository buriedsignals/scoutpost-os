import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";

function normalizeLineEndings(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

const workflow = normalizeLineEndings(
  await Deno.readTextFile(
    new URL("../../.github/workflows/cli-release.yml", import.meta.url),
  ),
);
const ciWorkflow = normalizeLineEndings(
  await Deno.readTextFile(
    new URL("../../.github/workflows/ci.yml", import.meta.url),
  ),
);
const attestationSource = await Deno.readTextFile(
  new URL("../release-attestation/attest.mjs", import.meta.url),
);
const signWindowsStart = workflow.indexOf("\n  sign-windows:\n");
const releaseStart = workflow.indexOf("\n  release:\n", signWindowsStart);
assert(signWindowsStart >= 0 && releaseStart > signWindowsStart);
const signWindows = workflow.slice(signWindowsStart, releaseStart);
const attestationStart = signWindows.indexOf(
  "      - name: Install local provenance signer\n",
);
const uploadStart = signWindows.indexOf(
  "      - uses: actions/upload-artifact@",
  attestationStart,
);
assert(attestationStart >= 0 && uploadStart > attestationStart);
const attestationStep = signWindows.slice(attestationStart, uploadStart);
const lifecycleStart = signWindows.indexOf(
  "      - name: Native signed-binary and npm install/update/uninstall lifecycle\n",
);
assert(lifecycleStart >= 0 && attestationStart > lifecycleStart);
const lifecycleStep = signWindows.slice(lifecycleStart, attestationStart);

Deno.test("workflow parsing normalizes Windows line endings", () => {
  assertEquals(
    normalizeLineEndings("first\r\nsecond\rthird"),
    "first\nsecond\nthird",
  );
});

Deno.test("Windows signing evidence records protected Azure coordinates", () => {
  for (
    const field of [
      "artifact_signing_endpoint=$env:ARTIFACT_SIGNING_ENDPOINT",
      "artifact_signing_account=$env:ARTIFACT_SIGNING_ACCOUNT",
      "artifact_signing_profile=$env:ARTIFACT_SIGNING_PROFILE",
    ]
  ) {
    assertStringIncludes(signWindows, field);
  }
});

Deno.test("Windows release derives the complete version from an anchored tag", () => {
  assert(!signWindows.includes("Substring(6)"));
  assertEquals(
    signWindows.match(/\$version = \$Matches\[1\]/g)?.length,
    2,
  );
  assertStringIncludes(
    signWindows,
    "^cli-v([0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?)$",
  );
});

Deno.test("Windows lifecycle uses valid Deno and npm working directories", () => {
  assertStringIncludes(lifecycleStep, "deno task --cwd=cli smoke-windows");
  assert(!lifecycleStep.includes("deno --cwd cli task"));
  assertStringIncludes(lifecycleStep, "Push-Location cli");
  assertStringIncludes(lifecycleStep, 'npm pkg set "version=$version"');
  assertStringIncludes(lifecycleStep, "npm pack --pack-destination $packDir");
  assert(!lifecycleStep.includes("npm pkg set --prefix cli"));
  assert(!lifecycleStep.includes("npm pack --prefix cli"));
});

Deno.test("Windows lifecycle fails on native command errors", () => {
  assertStringIncludes(lifecycleStep, "$ErrorActionPreference = 'Stop'");
  assertStringIncludes(lifecycleStep, "function Assert-NativeSuccess");
  assertStringIncludes(
    lifecycleStep,
    "Assert-NativeSuccess 'native Windows smoke test'",
  );
  assertStringIncludes(
    lifecycleStep,
    "Assert-NativeSuccess 'uninstalling the release candidate'",
  );
});

Deno.test("Windows lifecycle only updates from a Windows-capable package", () => {
  assertStringIncludes(
    lifecycleStep,
    'npm pack --ignore-scripts --pack-destination $priorPackDir "scoutpost-cli@$prior"',
  );
  assertStringIncludes(
    lifecycleStep,
    "Select-String -LiteralPath $priorPlatform -SimpleMatch '\"win32-x86_64\"' -Quiet",
  );
  assertStringIncludes(
    lifecycleStep,
    "status=($didUpdate ? 'update-uninstall-verified' : 'install-uninstall-verified')",
  );
});

Deno.test("Windows lifecycle delimits variables before punctuation", () => {
  assertStringIncludes(
    lifecycleStep,
    'throw "installed binary did not report ${version}: $actualVersion"',
  );
  assert(
    !lifecycleStep.includes(
      'throw "installed binary did not report $version: $actualVersion"',
    ),
  );
});

Deno.test("npm publication dry-run names the CLI package directory explicitly", () => {
  assertStringIncludes(
    workflow,
    'npm pack ./cli --dry-run --json > "$RUNNER_TEMP/scout-npm-pack.json"',
  );
});

Deno.test("PR CI parses the embedded Windows lifecycle with PowerShell", () => {
  assertStringIncludes(
    ciWorkflow,
    "      - name: Parse Windows release lifecycle PowerShell\n" +
      "        shell: pwsh\n" +
      "        run: ./cli/scripts/check_release_powershell.ps1\n",
  );
});

Deno.test("all four Windows constituent files receive local signed release provenance", () => {
  assert(!signWindows.includes("attestations: write"));
  assert(!attestationStep.includes("actions/attest-build-provenance"));
  assertStringIncludes(signWindows, "          node-version: 22.22.2\n");
  assertStringIncludes(
    attestationStep,
    "working-directory: cli/release-attestation\n" +
      "        run: npm ci --ignore-scripts --engine-strict",
  );
  assertStringIncludes(
    attestationStep,
    "run: node cli/release-attestation/attest.mjs",
  );
  assertStringIncludes(
    attestationStep,
    "--bundle $bundle",
  );
  assertStringIncludes(attestationStep, "--no-public-good");
  for (
    const path of [
      "cli/dist/scout-windows-x86_64.exe",
      "cli/dist/scout-windows-x86_64.exe.sha256",
      "cli/dist/scout-windows-evidence.json",
      "cli/dist/scout-windows-lifecycle.json",
    ]
  ) {
    assertStringIncludes(attestationStep, path);
  }
  assertStringIncludes(
    signWindows,
    "cli/dist/scout-windows-provenance.bundle.jsonl",
  );
});

Deno.test("CLI CI signs and verifies a local private-repository bundle", () => {
  assertStringIncludes(ciWorkflow, "\n  cli-local-attestation:\n");
  assertStringIncludes(ciWorkflow, "      id-token: write\n");
  assertStringIncludes(ciWorkflow, "          node-version: 22.22.2\n");
  assertStringIncludes(
    ciWorkflow,
    "run: node cli/release-attestation/attest_ci_check.mjs",
  );
  assertStringIncludes(
    ciWorkflow,
    "--signer-workflow buriedsignals/scoutpost/.github/workflows/ci.yml",
  );
  assertStringIncludes(ciWorkflow, "--no-public-good");
  assertStringIncludes(
    attestationSource,
    'ref === "refs/heads/develop"',
  );
});

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";

function normalizeLineEndings(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

const workflow = normalizeLineEndings(
  await Deno.readTextFile(
    new URL("../../.github/workflows/cli-release.yml", import.meta.url),
  ),
);
const signWindowsStart = workflow.indexOf("\n  sign-windows:\n");
const releaseStart = workflow.indexOf("\n  release:\n", signWindowsStart);
assert(signWindowsStart >= 0 && releaseStart > signWindowsStart);
const signWindows = workflow.slice(signWindowsStart, releaseStart);
const attestationStart = signWindows.indexOf(
  "      - name: Attest signed Windows release provenance\n",
);
const uploadStart = signWindows.indexOf(
  "      - uses: actions/upload-artifact@",
  attestationStart,
);
assert(attestationStart >= 0 && uploadStart > attestationStart);
const attestationStep = signWindows.slice(attestationStart, uploadStart);

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

Deno.test("Windows lifecycle script delimits variables before punctuation", () => {
  assertStringIncludes(
    signWindows,
    'throw "updated binary did not report ${version}: $actualVersion"',
  );
  assert(
    !signWindows.includes(
      'throw "updated binary did not report $version: $actualVersion"',
    ),
  );
});

Deno.test("all four Windows constituent files receive release provenance", () => {
  assertStringIncludes(signWindows, "attestations: write");
  assertStringIncludes(
    attestationStep,
    "actions/attest-build-provenance@43d14bc2b83dec42d39ecae14e916627a18bb661",
  );
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
});

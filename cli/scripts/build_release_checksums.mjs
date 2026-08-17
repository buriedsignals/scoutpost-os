import { lstat, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const RELEASE_ASSETS = Object.freeze([
  "scout-darwin-arm64",
  "scout-darwin-x86_64",
  "scout-linux-arm64",
  "scout-linux-x86_64",
  "scout-windows-x86_64.exe",
]);

const EVIDENCE_FIELDS = Object.freeze([
  "schema_version",
  "status",
  "version",
  "source_revision",
  "repository",
  "workflow_run_id",
  "workflow_run_attempt",
  "ref_name",
  "artifact_signing_endpoint",
  "artifact_signing_account",
  "artifact_signing_profile",
  "publisher_subject",
  "sha256",
]);

const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const SHA_RE = /^[a-f0-9]{40}$/;
const ID_RE = /^[1-9][0-9]*$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

async function boundedText(path, maximum, label) {
  const info = await lstat(path);
  if (
    info.isSymbolicLink() || !info.isFile() || info.size < 1 ||
    info.size > maximum
  ) {
    throw new Error(`${label} must be a bounded regular file`);
  }
  return readFile(path, "utf8");
}

function exactFields(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    throw new Error(`${label} fields are invalid`);
  }
  return value;
}

function boundedString(value, minimum, maximum) {
  return typeof value === "string" && value.length >= minimum &&
    value.length <= maximum && !CONTROL_RE.test(value);
}

function validateContext(context) {
  if (
    !context || !VERSION_RE.test(context.version ?? "") ||
    !SHA_RE.test(context.sourceRevision ?? "") ||
    context.repository !== "buriedsignals/scoutpost" ||
    !ID_RE.test(context.runID ?? "") || !ID_RE.test(context.runAttempt ?? "") ||
    context.refName !== `cli-v${context.version}`
  ) {
    throw new Error("release checksum context is invalid");
  }
  return context;
}

function validateEvidence(evidence, context, digests) {
  exactFields(evidence, EVIDENCE_FIELDS, "Windows signing evidence");
  let endpoint;
  try {
    endpoint = new URL(evidence.artifact_signing_endpoint);
  } catch {
    throw new Error("Windows signing evidence endpoint is invalid");
  }
  if (
    evidence.schema_version !== "scoutpost-native-evidence/v1" ||
    evidence.status !== "signature-verified" ||
    evidence.version !== context.version ||
    evidence.source_revision !== context.sourceRevision ||
    evidence.repository !== context.repository ||
    String(evidence.workflow_run_id) !== context.runID ||
    String(evidence.workflow_run_attempt) !== context.runAttempt ||
    evidence.ref_name !== context.refName ||
    endpoint.protocol !== "https:" || endpoint.username || endpoint.password ||
    endpoint.search || endpoint.hash || endpoint.pathname !== "/" ||
    !endpoint.hostname.endsWith(".codesigning.azure.net") ||
    !boundedString(evidence.artifact_signing_account, 3, 128) ||
    !boundedString(evidence.artifact_signing_profile, 3, 128) ||
    !boundedString(evidence.publisher_subject, 3, 512) ||
    evidence.sha256 !== digests["scout-windows-x86_64.exe"]
  ) {
    throw new Error(
      "Windows signing evidence does not match this immutable release run",
    );
  }
  return evidence;
}

export async function buildReleaseChecksums(
  { releaseDirectory, out, context },
) {
  const release = resolve(releaseDirectory);
  const output = resolve(out);
  validateContext(context);
  const digests = {};
  for (const asset of RELEASE_ASSETS) {
    const checksumPath = resolve(release, `${asset}.sha256`);
    if (
      dirname(checksumPath) !== release ||
      basename(checksumPath) !== `${asset}.sha256`
    ) {
      throw new Error("release checksum path escaped its directory");
    }
    const line = (await boundedText(checksumPath, 1024, `${asset} checksum`))
      .trim();
    const match = /^([a-fA-F0-9]{64})\s+([^\r\n]+)$/.exec(line);
    if (!match || match[2] !== asset) {
      throw new Error(`invalid checksum file for ${asset}`);
    }
    digests[asset] = match[1].toLowerCase();
  }
  const evidencePath = resolve(release, "scout-windows-evidence.json");
  if (dirname(evidencePath) !== release) {
    throw new Error("release evidence path escaped its directory");
  }
  const evidence = validateEvidence(
    JSON.parse(
      await boundedText(evidencePath, 64 * 1024, "Windows signing evidence"),
    ),
    context,
    digests,
  );
  const manifest = {
    schema_version: "scoutpost-binary-checksums/v1",
    version: context.version,
    publisher_subject: evidence.publisher_subject,
    assets: digests,
  };
  await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o644,
  });
  return manifest;
}

function parseArgs(argv) {
  if (
    argv.length !== 4 || argv[0] !== "--release-dir" || argv[2] !== "--out"
  ) {
    throw new Error(
      "usage: build_release_checksums.mjs --release-dir DIRECTORY --out FILE",
    );
  }
  return { releaseDirectory: argv[1], out: argv[3] };
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  buildReleaseChecksums({
    ...parseArgs(process.argv.slice(2)),
    context: {
      version: process.env.VERSION,
      sourceRevision: process.env.GITHUB_SHA,
      repository: process.env.GITHUB_REPOSITORY,
      runID: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      refName: process.env.GITHUB_REF_NAME,
    },
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

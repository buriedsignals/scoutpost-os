import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { bundleToJSON } from "@sigstore/bundle";
import {
  CIContextProvider,
  DSSEBundleBuilder,
  FulcioSigner,
  TSAWitness,
} from "@sigstore/sign";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");
const MAX_SUBJECT_BYTES = 512 * 1024 * 1024;

export const RELEASE_SUBJECT_NAMES = Object.freeze([
  "scout-windows-x86_64.exe",
  "scout-windows-x86_64.exe.sha256",
  "scout-windows-evidence.json",
  "scout-windows-lifecycle.json",
]);

export const RELEASE_BUNDLE_NAME = "scout-windows-provenance.bundle.jsonl";

const INTOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
const INTOTO_PAYLOAD_TYPE = "application/vnd.in-toto+json";
const SLSA_PREDICATE_TYPE = "https://slsa.dev/provenance/v1";
const GITHUB_BUILD_TYPE = "https://actions.github.io/buildtypes/workflow/v1";
const FULCIO_URL = "https://fulcio.githubapp.com";
const TIMESTAMP_URL = "https://timestamp.githubapp.com";

async function subject(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(
      `Attestation subject is not a regular file: ${basename(path)}`,
    );
  }
  if (info.size < 1 || info.size > MAX_SUBJECT_BYTES) {
    throw new Error(
      `Attestation subject has an invalid size: ${basename(path)}`,
    );
  }
  const bytes = await readFile(path);
  return {
    name: basename(path),
    digest: { sha256: createHash("sha256").update(bytes).digest("hex") },
  };
}

function requiredEnvironment(name, pattern) {
  const value = process.env[name];
  if (!value || !pattern.test(value)) {
    throw new Error(`GitHub attestation environment is invalid: ${name}`);
  }
  return value;
}

function provenanceStatement(subjects) {
  const repository = requiredEnvironment(
    "GITHUB_REPOSITORY",
    /^buriedsignals\/scoutpost$/,
  );
  const sha = requiredEnvironment("GITHUB_SHA", /^[a-f0-9]{40}$/);
  const ref = requiredEnvironment(
    "GITHUB_REF",
    /^refs\/(?:heads\/develop|tags\/cli-v[0-9A-Za-z.-]+|pull\/[1-9][0-9]*\/merge)$/,
  );
  const workflowRef = requiredEnvironment(
    "GITHUB_WORKFLOW_REF",
    /^buriedsignals\/scoutpost\/\.github\/workflows\/(?:ci|cli-release)\.yml@refs\/.+$/,
  );
  const workflowPath = workflowRef.slice(`${repository}/`.length).split("@")[0];
  const runID = requiredEnvironment("GITHUB_RUN_ID", /^[1-9][0-9]*$/);
  const runAttempt = requiredEnvironment("GITHUB_RUN_ATTEMPT", /^[1-9][0-9]*$/);
  const repositoryID = requiredEnvironment(
    "GITHUB_REPOSITORY_ID",
    /^[1-9][0-9]*$/,
  );
  const ownerID = requiredEnvironment(
    "GITHUB_REPOSITORY_OWNER_ID",
    /^[1-9][0-9]*$/,
  );
  const eventName = requiredEnvironment(
    "GITHUB_EVENT_NAME",
    /^(?:pull_request|push)$/,
  );
  const validInvocation = workflowPath === ".github/workflows/ci.yml"
    ? (eventName === "pull_request" &&
      /^refs\/pull\/[1-9][0-9]*\/merge$/.test(ref)) ||
      (eventName === "push" && ref === "refs/heads/develop")
    : workflowPath === ".github/workflows/cli-release.yml" &&
      eventName === "push" && /^refs\/tags\/cli-v/.test(ref);
  if (!validInvocation) {
    throw new Error("GitHub attestation workflow, event, and ref do not match");
  }
  if (
    process.env.GITHUB_SERVER_URL !== "https://github.com" ||
    process.env.RUNNER_ENVIRONMENT !== "github-hosted"
  ) {
    throw new Error("GitHub attestation requires a hosted github.com runner");
  }

  return {
    _type: INTOTO_STATEMENT_TYPE,
    subject: subjects,
    predicateType: SLSA_PREDICATE_TYPE,
    predicate: {
      buildDefinition: {
        buildType: GITHUB_BUILD_TYPE,
        externalParameters: {
          workflow: {
            ref,
            repository: `https://github.com/${repository}`,
            path: workflowPath,
          },
        },
        internalParameters: {
          github: {
            event_name: eventName,
            repository_id: repositoryID,
            repository_owner_id: ownerID,
            runner_environment: "github-hosted",
          },
        },
        resolvedDependencies: [{
          uri: `git+https://github.com/${repository}@${ref}`,
          digest: { gitCommit: sha },
        }],
      },
      runDetails: {
        builder: { id: `https://github.com/${workflowRef}` },
        metadata: {
          invocationId:
            `https://github.com/${repository}/actions/runs/${runID}/attempts/${runAttempt}`,
        },
      },
    },
  };
}

async function signStatement(statement) {
  const signer = new FulcioSigner({
    identityProvider: new CIContextProvider("sigstore"),
    fulcioBaseURL: FULCIO_URL,
  });
  const timestamp = new TSAWitness({ tsaBaseURL: TIMESTAMP_URL });
  const builder = new DSSEBundleBuilder({ signer, witnesses: [timestamp] });
  return builder.create({
    data: Buffer.from(JSON.stringify(statement)),
    type: INTOTO_PAYLOAD_TYPE,
  });
}

export async function createLocalProvenanceBundle(paths, outputPath) {
  if (!Array.isArray(paths) || paths.length < 1) {
    throw new Error("At least one attestation subject is required");
  }
  const subjects = await Promise.all(paths.map(subject));
  if (new Set(subjects.map((item) => item.name)).size !== subjects.length) {
    throw new Error("Attestation subject names must be unique");
  }

  const bundle = bundleToJSON(
    await signStatement(provenanceStatement(subjects)),
  );
  await writeFile(outputPath, `${JSON.stringify(bundle)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return { outputPath, subjects };
}

function assertReleaseContext() {
  if (
    process.env.GITHUB_REPOSITORY !== "buriedsignals/scoutpost" ||
    process.env.GITHUB_WORKFLOW !== "CLI Release" ||
    process.env.GITHUB_REF_TYPE !== "tag" ||
    !/^cli-v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(
      process.env.GITHUB_REF_NAME ?? "",
    ) ||
    !/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? "") ||
    process.env.GITHUB_SHA !== process.env.GITHUB_WORKFLOW_SHA ||
    process.env.RUNNER_ENVIRONMENT !== "github-hosted"
  ) {
    throw new Error(
      "Release provenance requires the immutable hosted CLI release context",
    );
  }
}

async function main() {
  assertReleaseContext();
  const paths = RELEASE_SUBJECT_NAMES.map((name) => join(dist, name));
  const { subjects } = await createLocalProvenanceBundle(
    paths,
    join(dist, RELEASE_BUNDLE_NAME),
  );
  console.log(
    `scoutpost-cli: created local GitHub provenance bundle for ${subjects.length} Windows release files`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

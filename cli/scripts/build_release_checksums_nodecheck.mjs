import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildReleaseChecksums,
  RELEASE_ASSETS,
} from "./build_release_checksums.mjs";

const WINDOWS_DIGEST = "5".repeat(64);
const CONTEXT = Object.freeze({
  version: "0.1.21",
  sourceRevision: "a".repeat(40),
  repository: "buriedsignals/scoutpost",
  runID: "123",
  runAttempt: "1",
  refName: "cli-v0.1.21",
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "scout-checksums-test-"));
  const out = join(root, "checksums.json");
  for (const [index, asset] of RELEASE_ASSETS.entries()) {
    const digest = asset === "scout-windows-x86_64.exe"
      ? WINDOWS_DIGEST
      : String(index + 1).repeat(64);
    await writeFile(join(root, `${asset}.sha256`), `${digest}  ${asset}\n`);
  }
  const evidence = {
    schema_version: "scoutpost-native-evidence/v1",
    status: "signature-verified",
    version: CONTEXT.version,
    source_revision: CONTEXT.sourceRevision,
    repository: CONTEXT.repository,
    workflow_run_id: CONTEXT.runID,
    workflow_run_attempt: CONTEXT.runAttempt,
    ref_name: CONTEXT.refName,
    artifact_signing_endpoint: "https://eus.codesigning.azure.net/",
    artifact_signing_account: "indicatorlabs-as-8a185f",
    artifact_signing_profile: "indicator-public",
    publisher_subject: "CN=Buried Signals Test",
    sha256: WINDOWS_DIGEST,
  };
  await writeFile(
    join(root, "scout-windows-evidence.json"),
    JSON.stringify(evidence),
  );
  return {
    root,
    out,
    evidence,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("release checksum manifest derives its publisher from bound signing evidence", async () => {
  const work = await fixture();
  try {
    const manifest = await buildReleaseChecksums({
      releaseDirectory: work.root,
      out: work.out,
      context: CONTEXT,
    });
    assert.equal(manifest.publisher_subject, work.evidence.publisher_subject);
    assert.equal(
      manifest.assets["scout-windows-x86_64.exe"],
      WINDOWS_DIGEST,
    );
    assert.deepEqual(JSON.parse(await readFile(work.out, "utf8")), manifest);
  } finally {
    await work.cleanup();
  }
});

test("release checksum manifest rejects evidence from another run", async () => {
  const work = await fixture();
  try {
    work.evidence.workflow_run_id = "999";
    await writeFile(
      join(work.root, "scout-windows-evidence.json"),
      JSON.stringify(work.evidence),
    );
    await assert.rejects(
      () =>
        buildReleaseChecksums({
          releaseDirectory: work.root,
          out: work.out,
          context: CONTEXT,
        }),
      /does not match this immutable release run/,
    );
  } finally {
    await work.cleanup();
  }
});

test("release checksum manifest rejects a checksum/evidence digest mismatch", async () => {
  const work = await fixture();
  try {
    work.evidence.sha256 = "f".repeat(64);
    await writeFile(
      join(work.root, "scout-windows-evidence.json"),
      JSON.stringify(work.evidence),
    );
    await assert.rejects(
      () =>
        buildReleaseChecksums({
          releaseDirectory: work.root,
          out: work.out,
          context: CONTEXT,
        }),
      /does not match this immutable release run/,
    );
  } finally {
    await work.cleanup();
  }
});

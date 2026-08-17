import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createLocalProvenanceBundle } from "./attest.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const runnerTemp = process.env.RUNNER_TEMP;
if (!runnerTemp) throw new Error("RUNNER_TEMP is required");

const subjects = [
  join(here, "..", "scripts", "checksums.json"),
  join(here, "..", "scripts", "platform.js"),
  join(here, "..", "scripts", "postinstall.js"),
  join(here, "..", "scripts", "release.js"),
];
const bundle = join(runnerTemp, "scoutpost-ci-provenance.bundle.jsonl");
await createLocalProvenanceBundle(subjects, bundle);
console.log(`scoutpost-cli: CI provenance bundle created at ${bundle}`);

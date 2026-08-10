// Run the maintained public scrape corpus against two already-running
// scrape-service revisions at the same time. This is the latency, memory,
// contract, and canonical-drift gate for Crawl4AI pin updates.
//
//   SCRAPE_SERVICE_TOKEN=... deno run \
//     --allow-env --allow-net --allow-run=docker --allow-write \
//     scripts/benchmarks/shadow-crawl4ai-versions.ts \
//     --control-url http://127.0.0.1:18089 \
//     --candidate-url http://127.0.0.1:18092 \
//     --control-container scoutpost-scrape-089-control \
//     --candidate-container scoutpost-scrape-092-validation \
//     --control-image sha256:006f46cbe4200daaec64f1a5e42115a7557da78647b1d734d0ad4002eef12a97 \
//     --candidate-image sha256:c2898b5a68a6ac000d40229adde8303d4428d9af9694f8d0548b7c54ab6dadfb \
//     --out /tmp/crawl4ai-shadow.json

import {
  validateContainerName,
  validateDistinctContainers,
  validateDistinctImages,
  validateImageId,
  validateLoopbackServiceOrigin,
} from "./_crawl4ai_shadow_config.ts";
import { compareShadowContract } from "./_crawl4ai_shadow_contract.ts";
import {
  dominantValue,
  shadowReleasePassed,
} from "./_crawl4ai_shadow_gates.ts";
import { scoreScrapeProbes, SCRAPE_CORPUS_CASES } from "./_scrape_corpus.ts";
import { webCanonicalHash } from "../../supabase/functions/_shared/web_content_canonical.ts";
import { sha256Hex } from "../../supabase/functions/_shared/unit_dedup.ts";

interface Options {
  controlUrl: string;
  candidateUrl: string;
  controlContainer: string;
  candidateContainer: string;
  controlImage: string;
  candidateImage: string;
  repetitions: number;
  allowedCanonicalDrift: Set<string>;
  out: string | null;
}

interface ScrapeResponse {
  markdown: string;
  rawHtml: string | null;
  title: string | null;
  metadata: Record<string, unknown>;
  requested_url: string;
  source_url: string;
  status_code: number | null;
}

interface TimedScrape {
  elapsed_ms: number;
  result: ScrapeResponse;
}

interface CorpusResult {
  id: string;
  elapsed_ms: number;
  result: ScrapeResponse;
  score: ReturnType<typeof scoreScrapeProbes>;
  sha256: string;
  canonical_sha256: string;
}

interface ShadowSide {
  elapsed_ms: number;
  bytes: number;
  sha256: string;
  canonical_sha256: string;
  matched_weight: number;
  possible_weight: number;
}

interface ShadowRecord {
  id: string;
  repetition: number;
  control: ShadowSide;
  candidate: ShadowSide;
  raw_equal: boolean;
  canonical_equal: boolean;
  canonical_drift_allowed: boolean;
  requested_url_equal: boolean;
  source_url_equal: boolean;
  status_code_equal: boolean;
  title_retained: boolean;
  raw_html_retained: boolean;
  missing_metadata_keys: string[];
  score_regression: boolean;
}

function parseArgs(): Options {
  let controlUrl: string | null = null;
  let candidateUrl: string | null = null;
  let controlContainer: string | null = null;
  let candidateContainer: string | null = null;
  let controlImage: string | null = null;
  let candidateImage: string | null = null;
  let repetitions = 3;
  const allowedCanonicalDrift = new Set<string>();
  let out: string | null = null;
  for (let i = 0; i < Deno.args.length; i++) {
    const arg = Deno.args[i];
    if (arg === "--control-url") controlUrl = Deno.args[++i];
    else if (arg === "--candidate-url") candidateUrl = Deno.args[++i];
    else if (arg === "--control-container") controlContainer = Deno.args[++i];
    else if (arg === "--candidate-container") {
      candidateContainer = Deno.args[++i];
    } else if (arg === "--control-image") {
      controlImage = Deno.args[++i];
    } else if (arg === "--candidate-image") {
      candidateImage = Deno.args[++i];
    } else if (arg === "--repetitions") {
      repetitions = Number(Deno.args[++i]);
    } else if (arg === "--allow-canonical-drift") {
      allowedCanonicalDrift.add(Deno.args[++i]);
    } else if (arg === "--out") out = Deno.args[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (
    !controlUrl || !candidateUrl || !controlContainer || !candidateContainer ||
    !controlImage || !candidateImage
  ) {
    throw new Error(
      "usage: --control-url <url> --candidate-url <url> " +
        "--control-container <name> --candidate-container <name> " +
        "--control-image <sha256:id> --candidate-image <sha256:id> " +
        "[--repetitions 3..10] [--allow-canonical-drift <case-id>] " +
        "[--out <path>]",
    );
  }
  if (!Number.isInteger(repetitions) || repetitions < 3 || repetitions > 10) {
    throw new Error("repetitions must be an integer from 3 through 10");
  }
  validateDistinctContainers(controlContainer, candidateContainer);
  validateDistinctImages(controlImage, candidateImage);
  const caseIds = new Set(SCRAPE_CORPUS_CASES.map((item) => item.id));
  for (const id of allowedCanonicalDrift) {
    if (!caseIds.has(id)) {
      throw new Error(`unknown canonical-drift case: ${id}`);
    }
  }
  return {
    controlUrl: validateLoopbackServiceOrigin("control", controlUrl),
    candidateUrl: validateLoopbackServiceOrigin("candidate", candidateUrl),
    controlContainer: validateContainerName("control", controlContainer),
    candidateContainer: validateContainerName("candidate", candidateContainer),
    controlImage: validateImageId("control", controlImage),
    candidateImage: validateImageId("candidate", candidateImage),
    repetitions,
    allowedCanonicalDrift,
    out,
  };
}

function assertScrapeContract(value: unknown): asserts value is ScrapeResponse {
  if (!value || typeof value !== "object") {
    throw new Error("response is not an object");
  }
  const body = value as Record<string, unknown>;
  if (typeof body.markdown !== "string") {
    throw new Error("markdown is not a string");
  }
  if (body.rawHtml !== null && typeof body.rawHtml !== "string") {
    throw new Error("rawHtml is not a string or null");
  }
  if (body.title !== null && typeof body.title !== "string") {
    throw new Error("title is not a string or null");
  }
  if (
    !body.metadata || typeof body.metadata !== "object" ||
    Array.isArray(body.metadata)
  ) {
    throw new Error("metadata is not an object");
  }
  if (typeof body.requested_url !== "string") {
    throw new Error("requested_url is not a string");
  }
  if (typeof body.source_url !== "string") {
    throw new Error("source_url is not a string");
  }
  if (body.status_code !== null && typeof body.status_code !== "number") {
    throw new Error("status_code is not a number or null");
  }
}

async function scrape(
  baseUrl: string,
  token: string,
  url: string,
): Promise<TimedScrape> {
  const started = performance.now();
  const response = await fetch(`${baseUrl}/scrape`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-scoutpost-workload-class": "utility",
    },
    body: JSON.stringify({ url, timeout_ms: 60_000 }),
    signal: AbortSignal.timeout(90_000),
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    throw new Error(
      `${baseUrl} returned ${response.status}: ${
        JSON.stringify(body).slice(0, 300)
      }`,
    );
  }
  assertScrapeContract(body);
  return { elapsed_ms: Math.round(performance.now() - started), result: body };
}

function percentile95(values: number[]): number {
  if (values.length === 0) {
    throw new Error("cannot calculate p95 of an empty set");
  }
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.ceil(ordered.length * 0.95) - 1];
}

function median(values: number[]): number {
  if (values.length === 0) {
    throw new Error("cannot calculate median of an empty set");
  }
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

function rotate<T>(values: T[], offset: number): T[] {
  const normalized = offset % values.length;
  return [...values.slice(normalized), ...values.slice(0, normalized)];
}

async function readCgroupPeak(container: string): Promise<number> {
  const command = new Deno.Command("docker", {
    args: ["exec", container, "cat", "/sys/fs/cgroup/memory.peak"],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  if (!output.success) {
    throw new Error(
      `cannot read cgroup peak for ${container}: ${
        new TextDecoder().decode(output.stderr).trim()
      }`,
    );
  }
  const bytes = Number(new TextDecoder().decode(output.stdout).trim());
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error(`invalid cgroup peak for ${container}`);
  }
  return bytes;
}

async function restartContainer(container: string): Promise<void> {
  const command = new Deno.Command("docker", {
    args: ["restart", container],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  if (!output.success) {
    throw new Error(
      `cannot restart ${container}: ${
        new TextDecoder().decode(output.stderr).trim()
      }`,
    );
  }
}

async function verifyContainerImage(
  container: string,
  expectedImage: string,
): Promise<void> {
  const command = new Deno.Command("docker", {
    args: ["inspect", "--format", "{{.Image}}", container],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  if (!output.success) {
    throw new Error(
      `cannot inspect ${container}: ${
        new TextDecoder().decode(output.stderr).trim()
      }`,
    );
  }
  const actualImage = new TextDecoder().decode(output.stdout).trim();
  if (actualImage !== expectedImage) {
    throw new Error(
      `${container} uses ${actualImage || "an unknown image"}; ` +
        `expected ${expectedImage}`,
    );
  }
}

async function waitForHealth(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {
      // Container restarts briefly refuse connections.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${baseUrl} did not become healthy after restart`);
}

async function runCorpus(
  label: string,
  repetition: number,
  baseUrl: string,
  token: string,
  order: typeof SCRAPE_CORPUS_CASES,
): Promise<Map<string, CorpusResult>> {
  const results = new Map<string, CorpusResult>();
  for (const corpusCase of order) {
    const timed = await scrape(baseUrl, token, corpusCase.url);
    const score = scoreScrapeProbes(timed.result.markdown, corpusCase.probes);
    const result = {
      id: corpusCase.id,
      elapsed_ms: timed.elapsed_ms,
      result: timed.result,
      score,
      sha256: await sha256Hex(timed.result.markdown),
      canonical_sha256: await webCanonicalHash(timed.result.markdown),
    };
    results.set(corpusCase.id, result);
    console.log(
      `${label} r${repetition} ${corpusCase.id}: ${result.elapsed_ms}ms; ` +
        `score ${score.matched}/${score.possible}`,
    );
    // Council sites are small public infrastructure. Keep requests serial per
    // image and leave a gap even though the two images remain under load.
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return results;
}

const options = parseArgs();
const token = Deno.env.get("SCRAPE_SERVICE_TOKEN");
if (!token) throw new Error("SCRAPE_SERVICE_TOKEN not set");

const controlRuns = new Map<string, CorpusResult[]>();
const candidateRuns = new Map<string, CorpusResult[]>();
const controlRepetitionPeaks: number[] = [];
const candidateRepetitionPeaks: number[] = [];
await Promise.all([
  verifyContainerImage(options.controlContainer, options.controlImage),
  verifyContainerImage(options.candidateContainer, options.candidateImage),
]);
for (let repetition = 1; repetition <= options.repetitions; repetition++) {
  // Give every repetition a fresh browser process. This keeps per-origin WAF
  // cookies/session state from turning later repetitions into synthetic error
  // pages. Capture the cgroup peak before the next restart and compare the
  // maximum equal-load repetition for each image.
  await Promise.all([
    restartContainer(options.controlContainer),
    restartContainer(options.candidateContainer),
  ]);
  await Promise.all([
    waitForHealth(options.controlUrl),
    waitForHealth(options.candidateUrl),
  ]);
  // Warm both browser processes on a non-corpus page. Cold launch then cannot
  // be assigned to a different corpus case merely because orders are rotated.
  await Promise.all([
    scrape(options.controlUrl, token, "https://example.com"),
    scrape(options.candidateUrl, token, "https://example.com"),
  ]);

  // Both revisions receive the same page sequence at the same time. Rotating
  // the starting case between repetitions distributes cold-origin effects
  // without biasing browser residue or memory toward different final pages.
  const controlOrder = rotate(SCRAPE_CORPUS_CASES, repetition - 1);
  const candidateOrder = controlOrder;
  const [control, candidate] = await Promise.all([
    runCorpus("control", repetition, options.controlUrl, token, controlOrder),
    runCorpus(
      "candidate",
      repetition,
      options.candidateUrl,
      token,
      candidateOrder,
    ),
  ]);
  for (const corpusCase of SCRAPE_CORPUS_CASES) {
    controlRuns.set(corpusCase.id, [
      ...(controlRuns.get(corpusCase.id) ?? []),
      control.get(corpusCase.id)!,
    ]);
    candidateRuns.set(corpusCase.id, [
      ...(candidateRuns.get(corpusCase.id) ?? []),
      candidate.get(corpusCase.id)!,
    ]);
  }
  const [controlPeak, candidatePeak] = await Promise.all([
    readCgroupPeak(options.controlContainer),
    readCgroupPeak(options.candidateContainer),
  ]);
  controlRepetitionPeaks.push(controlPeak);
  candidateRepetitionPeaks.push(candidatePeak);
}

const records: ShadowRecord[] = [];
let scoreRegressions = 0;
let contractMismatches = 0;
let probeFailures = 0;
for (const corpusCase of SCRAPE_CORPUS_CASES) {
  const controls = controlRuns.get(corpusCase.id) ?? [];
  const candidates = candidateRuns.get(corpusCase.id) ?? [];
  for (let index = 0; index < options.repetitions; index++) {
    const control = controls[index];
    const candidate = candidates[index];
    if (!control || !candidate) {
      throw new Error(
        `missing result for ${corpusCase.id} repetition ${index + 1}`,
      );
    }
    const scoreRegression = candidate.score.matched < control.score.matched;
    if (control.score.matched < control.score.possible) probeFailures++;
    if (candidate.score.matched < candidate.score.possible) probeFailures++;
    const contract = compareShadowContract(control.result, candidate.result);
    if (scoreRegression) scoreRegressions++;
    if (!contract.passed) contractMismatches++;
    records.push({
      id: corpusCase.id,
      repetition: index + 1,
      control: {
        elapsed_ms: control.elapsed_ms,
        bytes: control.result.markdown.length,
        sha256: control.sha256,
        canonical_sha256: control.canonical_sha256,
        matched_weight: control.score.matched,
        possible_weight: control.score.possible,
      },
      candidate: {
        elapsed_ms: candidate.elapsed_ms,
        bytes: candidate.result.markdown.length,
        sha256: candidate.sha256,
        canonical_sha256: candidate.canonical_sha256,
        matched_weight: candidate.score.matched,
        possible_weight: candidate.score.possible,
      },
      raw_equal: control.result.markdown === candidate.result.markdown,
      canonical_equal: control.canonical_sha256 === candidate.canonical_sha256,
      canonical_drift_allowed: options.allowedCanonicalDrift.has(corpusCase.id),
      requested_url_equal: contract.requested_url_equal,
      source_url_equal: contract.source_url_equal,
      status_code_equal: contract.status_code_equal,
      title_retained: contract.title_retained,
      raw_html_retained: contract.raw_html_retained,
      missing_metadata_keys: contract.missing_metadata_keys,
      score_regression: scoreRegression,
    });
  }
}

const canonicalDifferences = records.filter((record) =>
  !record.canonical_equal
);
// Public pages can legitimately change between two nearby fetches. Treat a
// repeated, version-specific dominant output as systematic drift, while still
// reporting every pairwise difference for review. Cases with no dominant
// output must be explicitly allowlisted with a written explanation.
const canonicalDriftByCase = SCRAPE_CORPUS_CASES.map((corpusCase) => {
  const caseRecords = records.filter((record) => record.id === corpusCase.id);
  const controlDominant = dominantValue(
    caseRecords.map((record) => record.control.canonical_sha256),
  );
  const candidateDominant = dominantValue(
    caseRecords.map((record) => record.candidate.canonical_sha256),
  );
  const allowed = options.allowedCanonicalDrift.has(corpusCase.id);
  const systematicMatch = controlDominant !== null &&
    controlDominant === candidateDominant;
  return {
    id: corpusCase.id,
    pairwise_differences: caseRecords.filter((record) =>
      !record.canonical_equal
    ).length,
    control_dominant_sha256: controlDominant,
    candidate_dominant_sha256: candidateDominant,
    allowed,
    passed: systematicMatch || allowed,
  };
});
const unexpectedCanonicalCases = canonicalDriftByCase.filter((record) =>
  !record.passed
);
const controlLatencies = records.map((record) => record.control.elapsed_ms);
const candidateLatencies = records.map((record) => record.candidate.elapsed_ms);
const perCaseLatency = SCRAPE_CORPUS_CASES.map((corpusCase) => {
  const caseRecords = records.filter((record) => record.id === corpusCase.id);
  const controlMedian = median(
    caseRecords.map((record) => record.control.elapsed_ms),
  );
  const candidateMedian = median(
    caseRecords.map((record) => record.candidate.elapsed_ms),
  );
  return {
    id: corpusCase.id,
    control_median_ms: controlMedian,
    candidate_median_ms: candidateMedian,
    candidate_ratio: Number((candidateMedian / controlMedian).toFixed(3)),
  };
});
const pairedMedianRatio = median(
  perCaseLatency.map((record) => record.candidate_ratio),
);
const controlP95 = percentile95(controlLatencies);
const candidateP95 = percentile95(candidateLatencies);
const p95Passed = candidateP95 <= controlP95 * 1.1;
const pairedMedianPassed = pairedMedianRatio <= 1.1;
const controlPeakBytes = Math.max(...controlRepetitionPeaks);
const candidatePeakBytes = Math.max(...candidateRepetitionPeaks);
const pairedMemoryRatios = candidateRepetitionPeaks.map(
  (candidatePeak, index) => candidatePeak / controlRepetitionPeaks[index],
);
const pairedMemoryMedianRatio = median(pairedMemoryRatios);
const memoryRegressionPassed = pairedMemoryMedianRatio <= 1.05;
const serviceLimitPassed = candidatePeakBytes <= 2 * 1024 * 1024 * 1024;
const report = {
  recorded_at: new Date().toISOString(),
  control_url: options.controlUrl,
  candidate_url: options.candidateUrl,
  control_image: options.controlImage,
  candidate_image: options.candidateImage,
  cases: SCRAPE_CORPUS_CASES.length,
  repetitions: options.repetitions,
  measured_samples_per_image: records.length,
  probe_failures: probeFailures,
  score_regressions: scoreRegressions,
  contract_mismatches: contractMismatches,
  canonical_drift: {
    allowed_case_ids: [...options.allowedCanonicalDrift].sort(),
    differences: canonicalDifferences.length,
    cases: canonicalDriftByCase,
    unexpected_case_ids: unexpectedCanonicalCases.map((record) => record.id),
    passed: unexpectedCanonicalCases.length === 0,
  },
  latency: {
    p95: {
      control_ms: controlP95,
      candidate_ms: candidateP95,
      candidate_delta_percent: Number(
        (((candidateP95 / controlP95) - 1) * 100).toFixed(1),
      ),
      gate_percent: 10,
      passed: p95Passed,
    },
    paired_case_median_ratio: Number(pairedMedianRatio.toFixed(3)),
    paired_case_median_delta_percent: Number(
      ((pairedMedianRatio - 1) * 100).toFixed(1),
    ),
    paired_case_gate_percent: 10,
    paired_case_passed: pairedMedianPassed,
    per_case: perCaseLatency,
    passed: p95Passed && pairedMedianPassed,
  },
  memory: {
    control_peak_bytes: controlPeakBytes,
    candidate_peak_bytes: candidatePeakBytes,
    control_repetition_peaks: controlRepetitionPeaks,
    candidate_repetition_peaks: candidateRepetitionPeaks,
    max_peak_delta_percent: Number(
      (((candidatePeakBytes / controlPeakBytes) - 1) * 100).toFixed(1),
    ),
    paired_repetition_median_ratio: Number(
      pairedMemoryMedianRatio.toFixed(3),
    ),
    paired_repetition_median_delta_percent: Number(
      ((pairedMemoryMedianRatio - 1) * 100).toFixed(1),
    ),
    regression_gate_percent: 5,
    service_limit_bytes: 2 * 1024 * 1024 * 1024,
    regression_passed: memoryRegressionPassed,
    service_limit_passed: serviceLimitPassed,
    passed: memoryRegressionPassed && serviceLimitPassed,
  },
  records,
};
const reportText = `${JSON.stringify(report, null, 2)}\n`;
if (options.out) await Deno.writeTextFile(options.out, reportText);
console.log(`\n${reportText}`);

if (
  !shadowReleasePassed({
    probeFailures,
    scoreRegressions,
    contractMismatches,
    canonicalPassed: report.canonical_drift.passed,
    latencyPassed: report.latency.passed,
    memoryPassed: report.memory.passed,
  })
) {
  Deno.exit(1);
}

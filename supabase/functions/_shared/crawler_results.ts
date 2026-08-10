import { encodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";
import type { SupabaseClient } from "./supabase.ts";
import { sha256HexBytes } from "./snapshot_store.ts";

const COMPRESSED_MAX = 50 * 1024 * 1024;
const RESULT_DECODED_MAX = 16 * 1024 * 1024;
const SNAPSHOT_DECODED_MAX = 25 * 1024 * 1024;
const SNAPSHOT_COMBINED_MAX = 30 * 1024 * 1024;

export interface CrawlerArtifact {
  kind: string;
  path: string;
  bytes: number;
  sha256: string;
}

export interface CrawlerResultRow {
  id: string;
  result_manifest: Record<string, unknown> | null;
}

export function crawlerManifestProvider(
  manifest: Record<string, unknown> | null,
): "firecrawl" | "crawl4ai" | null {
  return manifest?.provider === "firecrawl" || manifest?.provider === "crawl4ai"
    ? manifest.provider
    : null;
}

export function crawlerManifestArtifacts(
  manifest: Record<string, unknown> | null,
): CrawlerArtifact[] {
  if (!Array.isArray(manifest?.artifacts)) return [];
  return manifest.artifacts.filter((value): value is CrawlerArtifact => {
    if (!value || typeof value !== "object") return false;
    const item = value as Record<string, unknown>;
    return typeof item.kind === "string" && typeof item.path === "string" &&
      Number.isInteger(item.bytes) && (item.bytes as number) > 0 &&
      typeof item.sha256 === "string";
  });
}

export async function loadCrawlerResult(
  svc: SupabaseClient,
  manifest: Record<string, unknown> | null,
  operation: "scrape" | "snapshot" | "parse_pdf" = "scrape",
  fetcher: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const artifacts = crawlerManifestArtifacts(manifest);
  const resultArtifact = artifacts.find((item) => item.kind === "result");
  if (!resultArtifact || resultArtifact.bytes > COMPRESSED_MAX) {
    throw new Error("invalid crawler result manifest");
  }
  const resultBytes = await fetchArtifact(svc, resultArtifact, fetcher);
  const decoded = await gunzipLimited(resultBytes, RESULT_DECODED_MAX);
  const parsed = JSON.parse(new TextDecoder().decode(decoded));
  if (
    !parsed || typeof parsed !== "object" ||
    typeof parsed.markdown !== "string" ||
    typeof parsed.source_url !== "string"
  ) {
    throw new Error("invalid crawler result");
  }
  if (operation !== "snapshot") return parsed as Record<string, unknown>;

  const snapshot = parsed.snapshot;
  if (
    (snapshot === undefined || snapshot === null) &&
    typeof parsed.snapshot_error === "string" &&
    parsed.snapshot_error.trim().length > 0
  ) {
    return parsed as Record<string, unknown>;
  }
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("invalid crawler snapshot result");
  }
  const payload = snapshot as Record<string, unknown>;
  const mhtmlArtifact = artifacts.find((item) => item.kind === "mhtml");
  const screenshotArtifact = artifacts.find((item) =>
    item.kind === "screenshot"
  );
  if (!mhtmlArtifact || !screenshotArtifact) {
    throw new Error("crawler snapshot artifacts missing");
  }
  const [mhtmlCompressed, screenshot] = await Promise.all([
    fetchArtifact(svc, mhtmlArtifact, fetcher),
    fetchArtifact(svc, screenshotArtifact, fetcher),
  ]);
  const mhtml = await gunzipLimited(mhtmlCompressed, SNAPSHOT_DECODED_MAX);
  if (
    screenshot.byteLength > SNAPSHOT_DECODED_MAX ||
    mhtml.byteLength + screenshot.byteLength > SNAPSHOT_COMBINED_MAX
  ) {
    throw new Error("crawler snapshot exceeds limit");
  }
  if (
    typeof payload.mhtml_sha256 !== "string" ||
    typeof payload.screenshot_sha256 !== "string" ||
    await sha256HexBytes(mhtml) !== payload.mhtml_sha256 ||
    await sha256HexBytes(screenshot) !== payload.screenshot_sha256
  ) {
    throw new Error("crawler snapshot integrity failure");
  }
  return {
    ...(parsed as Record<string, unknown>),
    snapshot: {
      ...payload,
      mhtml_b64: encodeBase64(mhtml),
      screenshot_b64: encodeBase64(screenshot),
    },
  };
}

export async function cleanupCrawlerResults(
  svc: SupabaseClient,
  rows: CrawlerResultRow[],
): Promise<void> {
  const paths = rows.flatMap((row) =>
    crawlerManifestArtifacts(row.result_manifest).map((artifact) =>
      artifact.path
    )
  );
  if (paths.length > 0) {
    const removed = await svc.storage.from("crawler-results").remove(paths);
    if (removed.error) throw new Error("crawler result cleanup failed");
  }
  if (rows.length > 0) {
    const cleared = await svc.from("crawler_jobs")
      .update({ result_manifest: null })
      .in("id", rows.map((row) => row.id));
    if (cleared.error) throw new Error("crawler manifest cleanup failed");
  }
}

export async function gzipCrawlerJson(value: unknown): Promise<Uint8Array> {
  const stream = new Blob([JSON.stringify(value)]).stream().pipeThrough(
    new CompressionStream("gzip"),
  );
  return await readLimited(stream, RESULT_DECODED_MAX);
}

async function fetchArtifact(
  svc: SupabaseClient,
  artifact: CrawlerArtifact,
  fetcher: typeof fetch,
): Promise<Uint8Array> {
  const signed = await svc.storage.from("crawler-results")
    .createSignedUrl(artifact.path, 60);
  if (signed.error || !signed.data?.signedUrl) {
    throw new Error("crawler result signing failed");
  }
  const response = await fetcher(signed.data.signedUrl, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error("crawler result unavailable");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (
    bytes.byteLength !== artifact.bytes ||
    await sha256HexBytes(bytes) !== artifact.sha256
  ) {
    throw new Error("crawler result integrity failure");
  }
  return bytes;
}

async function gunzipLimited(
  bytes: Uint8Array,
  limit: number,
): Promise<Uint8Array> {
  return await readLimited(
    new Blob([bytes.slice().buffer]).stream().pipeThrough(
      new DecompressionStream("gzip"),
    ),
    limit,
  );
}

async function readLimited(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) throw new Error("crawler result exceeds limit");
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

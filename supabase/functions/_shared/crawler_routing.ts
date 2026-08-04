export type CrawlerBackend = "service" | "workflow";
export type CrawlerPipeline = "page" | "beat" | "civic" | "utility";

export function stablePercent(cohortKey: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(cohortKey)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 100;
}

export function selectCrawlerBackend(
  cohortKey: string,
  pipeline: CrawlerPipeline,
  env: (name: string) => string | undefined = (name) => Deno.env.get(name),
): CrawlerBackend {
  if (env("CRAWLER_WORKFLOW_ENABLED") !== "true") return "service";
  const raw = Number(
    env(`CRAWLER_WORKFLOW_PERCENT_${pipeline.toUpperCase()}`) ?? "0",
  );
  const percent = Number.isFinite(raw) ? Math.min(100, Math.max(0, raw)) : 0;
  return stablePercent(cohortKey) < percent ? "workflow" : "service";
}

export function crawlerPipelineForScoutType(type: string): CrawlerPipeline {
  if (type === "web") return "page";
  if (type === "beat") return "beat";
  if (type === "civic") return "civic";
  throw new Error("scout type has no crawler pipeline");
}

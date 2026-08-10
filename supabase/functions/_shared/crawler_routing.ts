export type CrawlerBackend = "service" | "workflow";
export type CrawlerPipeline = "page" | "beat" | "civic" | "utility";
type EnvReader = (name: string) => string | undefined;

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
  env: EnvReader = (name) => Deno.env.get(name),
): CrawlerBackend {
  if (env("CRAWLER_WORKFLOW_ENABLED") !== "true") return "service";
  const percent = workflowPercent(pipeline, env);
  return stablePercent(cohortKey) < percent ? "workflow" : "service";
}

function workflowPercent(pipeline: CrawlerPipeline, env: EnvReader): number {
  const raw = Number(
    env(`CRAWLER_WORKFLOW_PERCENT_${pipeline.toUpperCase()}`) ?? "0",
  );
  return Number.isFinite(raw) ? Math.min(100, Math.max(0, raw)) : 0;
}

function forcedPageUser(userId: string, env: EnvReader): boolean {
  if (env("CRAWLER_WORKFLOW_ENABLED") !== "true") return false;
  if (workflowPercent("page", env) === 0) return false;
  return (env("CRAWLER_WORKFLOW_FORCE_PAGE_USER_IDS") ?? "")
    .split(/[\s,]+/)
    .some((candidate) => candidate === userId);
}

export function crawlerPipelineForScoutType(type: string): CrawlerPipeline {
  if (type === "web") return "page";
  if (type === "beat") return "beat";
  if (type === "civic") return "civic";
  throw new Error("scout type has no crawler pipeline");
}

/** Page Workflows do not yet run the post-finalization archive capture. */
export function pageWorkflowEligible(scout: {
  type: string;
  archive_enabled?: boolean | null;
}): boolean {
  return scout.type === "web" && scout.archive_enabled !== true;
}

export function selectScoutCrawlerBackend(
  scout: {
    id: string;
    user_id: string;
    type: string;
    archive_enabled?: boolean | null;
  },
  env: EnvReader = (name) => Deno.env.get(name),
): CrawlerBackend {
  const pipeline = crawlerPipelineForScoutType(scout.type);
  const selected = pipeline === "page" && forcedPageUser(scout.user_id, env)
    ? "workflow"
    : selectCrawlerBackend(scout.id, pipeline, env);
  return selected === "workflow" && !pageWorkflowEligible(scout)
    ? "service"
    : selected;
}

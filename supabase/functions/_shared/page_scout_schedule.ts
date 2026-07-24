export const MAX_PAGE_SCOUT_CANDIDATES = 500;

export function pageScoutCandidateKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const port = parsed.port ? `:${parsed.port}` : "";
    const pathname = parsed.pathname === "/"
      ? "/"
      : parsed.pathname.replace(/\/+$/, "");
    return `${hostname}${port}${pathname}${parsed.search}`;
  } catch {
    return url.replace(/\/+$/, "");
  }
}

export function capPageScoutCandidates(candidates: string[]): string[] {
  return candidates.slice(0, MAX_PAGE_SCOUT_CANDIDATES);
}

export function applyEffectiveCandidateUrls(
  candidates: string[],
  mappings: Array<{ requested: string; effective: string }>,
  normalize: (url: string) => string,
): string[] {
  const effectiveByRequested = new Map(
    mappings.map(({ requested, effective }) => [
      normalize(requested),
      effective,
    ]),
  );
  const deduped = new Map<string, string>();
  for (const candidate of candidates) {
    const effective = effectiveByRequested.get(normalize(candidate)) ??
      candidate;
    deduped.set(normalize(effective), effective);
  }
  return capPageScoutCandidates([...deduped.values()]);
}

export function candidateUrlValuesDiffer(
  current: string[],
  next: string[],
): boolean {
  return current.length !== next.length ||
    current.some((url, index) => url !== next[index]);
}

export function sortCandidatesByLastCheck(
  candidateUrls: string[],
  lastCapturedAt: ReadonlyMap<string, number>,
  lastAttemptedAt: ReadonlyMap<string, number>,
  normalize: (url: string) => string,
): string[] {
  const byTime = (a: string, b: string) => {
    const aKey = normalize(a);
    const bKey = normalize(b);
    const aTime = Math.max(
      lastCapturedAt.get(aKey) ?? Number.NEGATIVE_INFINITY,
      lastAttemptedAt.get(aKey) ?? Number.NEGATIVE_INFINITY,
    );
    const bTime = Math.max(
      lastCapturedAt.get(bKey) ?? Number.NEGATIVE_INFINITY,
      lastAttemptedAt.get(bKey) ?? Number.NEGATIVE_INFINITY,
    );
    return aTime - bTime || a.localeCompare(b);
  };
  const neverAttempted = candidateUrls
    .filter((url) => {
      const key = normalize(url);
      return !lastCapturedAt.has(key) && !lastAttemptedAt.has(key);
    })
    .sort(byTime);
  const previouslyAttempted = candidateUrls
    .filter((url) => {
      const key = normalize(url);
      return lastCapturedAt.has(key) || lastAttemptedAt.has(key);
    })
    .sort(byTime);
  if (neverAttempted.length === 0) return previouslyAttempted;
  if (previouslyAttempted.length === 0) return neverAttempted;

  // Interleave new and known children so a perpetually growing index cannot
  // starve previously monitored pages, while still onboarding new links.
  const ordered: string[] = [];
  const length = Math.max(neverAttempted.length, previouslyAttempted.length);
  for (let index = 0; index < length; index++) {
    if (neverAttempted[index]) ordered.push(neverAttempted[index]);
    if (previouslyAttempted[index]) ordered.push(previouslyAttempted[index]);
  }
  return ordered;
}

export function shouldCheckIndexChildren(input: {
  deterministicListing: boolean;
  knownChildCount: number;
  discoveredChildCount: number;
}): boolean {
  return input.deterministicListing || input.knownChildCount > 0 ||
    input.discoveredChildCount > 0;
}

export function selectActiveChildCandidates(input: {
  discovered: string[];
  knownSuccessful: string[];
  rootChanged: boolean;
}): string[] {
  // A real normalized root change can confirm membership additions/removals.
  // On an unchanged root, discovery can be partial (provider shell, deadline,
  // or missing render), so retain successful known children as well.
  if (input.rootChanged) return input.discovered;
  const selected: string[] = [];
  const seen = new Set<string>();
  const length = Math.max(
    input.discovered.length,
    input.knownSuccessful.length,
  );
  for (let index = 0; index < length; index++) {
    for (
      const candidate of [
        input.discovered[index],
        input.knownSuccessful[index],
      ]
    ) {
      if (candidate && !seen.has(candidate)) {
        seen.add(candidate);
        selected.push(candidate);
      }
    }
  }
  return selected;
}

export function summarizePageScoutCoverage(input: {
  childCandidates: number;
  childrenAttempted: number;
  childrenScraped: number;
  childrenFailed: number;
}): {
  sourcesScraped: number;
  sourcesFailed: number;
  coverageComplete: boolean;
} {
  return {
    sourcesScraped: 1 + input.childrenScraped,
    sourcesFailed: input.childrenFailed,
    coverageComplete: input.childrenAttempted === input.childCandidates &&
      input.childrenFailed === 0,
  };
}

export function isInitialChildBaseline(input: {
  status: "new" | "same" | "changed";
  requestedUrl: string;
  effectiveUrl: string;
  initialRootCandidates: ReadonlySet<string>;
  normalize: (url: string) => string;
}): boolean {
  if (input.status !== "new") return false;
  const requested = input.normalize(input.requestedUrl);
  const effective = input.normalize(input.effectiveUrl);
  if (
    input.initialRootCandidates.has(requested) ||
    input.initialRootCandidates.has(effective)
  ) return true;
  return false;
}

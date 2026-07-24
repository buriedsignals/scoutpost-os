export interface PageScoutSnapshotResult {
  sourceUrl: string;
  isRoot: boolean;
  diagnostics: Record<string, unknown>;
}

export interface PageScoutArchiveBatchItem<Context, Outcome> {
  context: Context;
  outcome: Outcome;
  captureError: unknown | null;
  trustError: unknown | null;
  trustDiagnostics: Record<string, unknown>;
  diagnosticsError: unknown | null;
}

export function pageScoutTrustDiagnostics(
  trustError: unknown | null,
  attempted = true,
  completed = true,
): Record<string, unknown> {
  if (!attempted) return { snapshot_trust_status: "not_applicable" };
  if (!completed && trustError === null) {
    return { snapshot_trust_status: "pending" };
  }
  return trustError === null ? { snapshot_trust_status: "ok" } : {
    snapshot_trust_status: "failed",
    snapshot_trust_error: trustError instanceof Error
      ? trustError.message
      : String(trustError),
  };
}

/**
 * Capture every source independently, persist capture diagnostics before the
 * slower trust layer, then persist the final per-source trust result. The
 * second write is deliberate: capture evidence survives a slow trust layer,
 * while trust failures remain visible instead of being log-only.
 */
export async function runPageScoutArchiveBatch<Context, Outcome>(
  contexts: readonly Context[],
  deps: {
    capture: (context: Context) => Promise<Outcome>;
    failureOutcome: (error: unknown) => Outcome;
    persistDiagnostics: (
      items: readonly PageScoutArchiveBatchItem<Context, Outcome>[],
    ) => Promise<void>;
    trust: (
      context: Context,
      outcome: Outcome,
    ) => Promise<Record<string, unknown> | void>;
  },
): Promise<Array<PageScoutArchiveBatchItem<Context, Outcome>>> {
  const items: Array<PageScoutArchiveBatchItem<Context, Outcome>> =
    await Promise.all(contexts.map(async (context) => {
      try {
        return {
          context,
          outcome: await deps.capture(context),
          captureError: null,
          trustError: null,
          trustDiagnostics: {},
          diagnosticsError: null,
        };
      } catch (error) {
        return {
          context,
          outcome: deps.failureOutcome(error),
          captureError: error,
          trustError: null,
          trustDiagnostics: {},
          diagnosticsError: null,
        };
      }
    }));
  try {
    await deps.persistDiagnostics(items);
  } catch (error) {
    for (const item of items) item.diagnosticsError = error;
  }
  await Promise.all(items.map(async (item) => {
    try {
      item.trustDiagnostics = (await deps.trust(item.context, item.outcome)) ??
        {};
    } catch (error) {
      item.trustError = error;
    }
  }));
  try {
    await deps.persistDiagnostics(items);
    for (const item of items) item.diagnosticsError = null;
  } catch (error) {
    for (const item of items) item.diagnosticsError = error;
  }
  return items;
}

export function shouldShowPageScoutArchiveCta(
  alertHasChild: boolean,
  hasRootArchiveContext: boolean,
): boolean {
  return !alertHasChild && hasRootArchiveContext;
}

export function pageScoutChildCaptureKind(input: {
  status: "new" | "same" | "changed";
  initialBaseline: boolean;
  alreadyArchived: boolean;
}): "baseline" | "change" | null {
  if (input.status === "changed") return "change";
  if (input.status === "new") {
    return input.initialBaseline ? "baseline" : "change";
  }
  // Archive enabled after monitoring began: the first post-enable successful
  // check records one non-retroactive baseline for an unchanged known child.
  return input.alreadyArchived ? null : "baseline";
}

export function buildPageScoutSnapshotMetadata(
  results: PageScoutSnapshotResult[],
  normalize: (url: string) => string,
): Record<string, unknown> {
  const root = results.find((result) => result.isRoot);
  return {
    ...(root?.diagnostics ?? {}),
    page_snapshot_sources: Object.fromEntries(
      results.map((result) => [
        normalize(result.sourceUrl),
        result.diagnostics,
      ]),
    ),
  };
}

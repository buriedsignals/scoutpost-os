const ERROR_FIELD = "_scoutpost_workflow_error";
const TENANT_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9:_.@-]{0,199}$/;

export function isCrawlerWorkflowProxyBase(base: string): boolean {
  return base.replace(/\/+$/, "").endsWith("/crawler-proxy");
}

/**
 * Tenant identity is supplied only by authenticated server-side callers. Keep
 * its wire representation deliberately narrow so it cannot smuggle control
 * characters or unbounded labels into admission locks and metrics.
 */
export function validatedCrawlerProxyTenantKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const tenantKey = value.trim();
  return TENANT_KEY_RE.test(tenantKey) ? tenantKey : null;
}

export function crawlerProxyTenantHeaders(
  base: string,
  tenantKey: string | undefined,
): Record<string, string> {
  if (!isCrawlerWorkflowProxyBase(base)) return {};
  const validated = validatedCrawlerProxyTenantKey(tenantKey);
  if (!validated) {
    throw new Error("crawler proxy requires a valid tenant key");
  }
  return { "X-Scoutpost-Tenant-Key": validated };
}

export function crawlerProxyErrorEnvelope(
  status: number,
  detail: unknown,
): Record<string, unknown> {
  return { [ERROR_FIELD]: { status, detail } };
}

export function readCrawlerProxyError(
  value: unknown,
): { status: number; detail: unknown } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const error = (value as Record<string, unknown>)[ERROR_FIELD];
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;
  const fields = error as Record<string, unknown>;
  return Number.isInteger(fields.status) &&
      (fields.status as number) >= 400 && (fields.status as number) <= 599
    ? { status: fields.status as number, detail: fields.detail }
    : null;
}

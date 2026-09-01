/**
 * CelesTrak GP refresh with a database-owned safety boundary.
 *
 * Provider I/O is disabled by default. An operator must record approval in
 * transport_gp_refresh_control and configure CELESTRAK_CONTACT_EMAIL before
 * the singleton lease can issue one request. Any non-200, timeout, invalid
 * payload, or cache publication error durably halts later requests until an
 * operator clears the halt.
 */

import type { SupabaseClient } from "../_shared/supabase.ts";
import { logEvent } from "../_shared/log.ts";

const CELESTRAK_ACTIVE =
  "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json";
const UPSERT_BATCH = 500;
const FETCH_TIMEOUT_MS = 30_000;
const LEASE_SECONDS = 120;
const MAX_ERROR_BODY_BYTES = 2_000;
const CONTACT_EMAIL_ENV = "CELESTRAK_CONTACT_EMAIL";

interface OmmRecord {
  NORAD_CAT_ID?: number | string;
  OBJECT_NAME?: string;
  EPOCH?: string;
  [k: string]: unknown;
}

type LeaseResult =
  & ({
    acquired: true;
    reason: "acquired";
  } | {
    acquired: false;
    reason: "disabled" | "halted" | "not_due" | "busy";
  })
  & {
    current_generation_id: string | null;
    current_generation_fetched_at: string | null;
  };

export interface GpRefreshResult {
  status: "updated" | "disabled" | "halted" | "not_due" | "busy";
  cached: number;
}

export interface GpRefreshOptions {
  fetch?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  timeoutMs?: number;
  contactEmail?: string;
}

export class GpRefreshFailure extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly providerStatus: number | null = null,
    public readonly providerDetail: string | null = null,
  ) {
    super(message);
    this.name = "GpRefreshFailure";
  }
}

function firstRow<T>(data: unknown): T | null {
  if (Array.isArray(data)) return (data[0] as T | undefined) ?? null;
  return (data as T | null) ?? null;
}

function contactUserAgent(configuredEmail?: string): string {
  const email = configuredEmail?.trim() ??
    Deno.env.get(CONTACT_EMAIL_ENV)?.trim() ?? "";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new GpRefreshFailure(
      "celestrak_contact_missing",
      `${CONTACT_EMAIL_ENV} must contain the operator contact email`,
    );
  }
  return `Scoutpost/1.0 (+mailto:${email})`;
}

async function boundedResponseText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let remaining = MAX_ERROR_BODY_BYTES;
  try {
    while (remaining > 0) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, remaining);
      parts.push(decoder.decode(chunk, { stream: true }));
      remaining -= chunk.byteLength;
      if (chunk.byteLength < value.byteLength) break;
    }
    parts.push(decoder.decode());
  } finally {
    await reader.cancel().catch(() => {});
  }
  return parts.join("").trim();
}

async function haltRefresh(
  svc: SupabaseClient,
  leaseToken: string,
  failure: GpRefreshFailure,
): Promise<void> {
  const { data, error } = await svc.rpc("halt_transport_gp_refresh", {
    p_lease_token: leaseToken,
    p_reason: failure.code,
    p_http_status: failure.providerStatus,
    p_error_body: failure.providerDetail ?? failure.message,
  });
  if (error || data !== true) {
    logEvent({
      level: "error",
      fn: "transport-sampler",
      event: "gp_halt_persist_failed",
      error_code: failure.code,
      msg: error?.message ?? "refresh lease was not halted",
    });
  }
}

async function acquireLease(
  svc: SupabaseClient,
  leaseToken: string,
): Promise<LeaseResult> {
  const { data, error } = await svc.rpc("acquire_transport_gp_refresh_lease", {
    p_lease_token: leaseToken,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (error) {
    throw new GpRefreshFailure(
      "gp_refresh_control_unavailable",
      `GP refresh control unavailable: ${error.message}`,
    );
  }
  const row = firstRow<LeaseResult>(data);
  if (!row) {
    throw new GpRefreshFailure(
      "gp_refresh_control_invalid",
      "GP refresh control returned no state",
    );
  }
  return row;
}

async function fetchCatalog(
  svc: SupabaseClient,
  leaseToken: string,
  options: GpRefreshOptions,
): Promise<OmmRecord[]> {
  let userAgent: string;
  try {
    userAgent = contactUserAgent(options.contactEmail);
  } catch (error) {
    const failure = error instanceof GpRefreshFailure
      ? error
      : new GpRefreshFailure("celestrak_contact_missing", String(error));
    await haltRefresh(svc, leaseToken, failure);
    throw failure;
  }

  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const fetchImpl = options.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(CELESTRAK_ACTIVE, {
      headers: {
        "Accept": "application/json",
        "User-Agent": userAgent,
      },
      signal: controller.signal,
    });
  } catch (error) {
    const timedOut = controller.signal.aborted;
    const failure = new GpRefreshFailure(
      timedOut ? "celestrak_timeout" : "celestrak_network_error",
      timedOut
        ? `CelesTrak request timed out after ${timeoutMs}ms`
        : `CelesTrak request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
    );
    await haltRefresh(svc, leaseToken, failure);
    throw failure;
  } finally {
    clearTimeout(timer);
  }

  if (response.status !== 200) {
    const detail = await boundedResponseText(response);
    const failure = new GpRefreshFailure(
      `celestrak_http_${response.status}`,
      `CelesTrak responded ${response.status}`,
      response.status,
      detail || null,
    );
    await haltRefresh(svc, leaseToken, failure);
    throw failure;
  }

  try {
    const records = await response.json();
    if (!Array.isArray(records) || records.length === 0) {
      throw new Error("response contained no GP records");
    }
    return records as OmmRecord[];
  } catch (error) {
    const failure = new GpRefreshFailure(
      "celestrak_invalid_response",
      `CelesTrak returned invalid GP JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      200,
    );
    await haltRefresh(svc, leaseToken, failure);
    throw failure;
  }
}

async function discardGeneration(
  svc: SupabaseClient,
  generationId: string,
): Promise<void> {
  const { error } = await svc
    .from("transport_gp_catalog")
    .delete()
    .eq("generation_id", generationId);
  if (error) {
    logEvent({
      level: "error",
      fn: "transport-sampler",
      event: "gp_generation_cleanup_failed",
      generation_id: generationId,
      msg: error.message,
    });
  }
}

async function publishCatalog(
  svc: SupabaseClient,
  leaseToken: string,
  records: OmmRecord[],
): Promise<number> {
  const generationId = crypto.randomUUID();
  const fetchedAt = new Date().toISOString();
  const rows = records
    .map((record) => {
      const norad = Number(record.NORAD_CAT_ID);
      if (!Number.isInteger(norad) || norad <= 0) return null;
      return {
        generation_id: generationId,
        norad_id: norad,
        name: typeof record.OBJECT_NAME === "string"
          ? record.OBJECT_NAME.trim()
          : null,
        omm: record,
        epoch: typeof record.EPOCH === "string" ? record.EPOCH : null,
        fetched_at: fetchedAt,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);
  if (rows.length === 0) {
    const failure = new GpRefreshFailure(
      "celestrak_empty_catalog",
      "CelesTrak GP response contained no valid catalog records",
      200,
    );
    await haltRefresh(svc, leaseToken, failure);
    throw failure;
  }

  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    const { error } = await svc
      .from("transport_gp_catalog")
      .insert(rows.slice(i, i + UPSERT_BATCH));
    if (error) {
      await discardGeneration(svc, generationId);
      const failure = new GpRefreshFailure(
        "gp_catalog_write_failed",
        `GP catalog staging failed: ${error.message}`,
      );
      await haltRefresh(svc, leaseToken, failure);
      throw failure;
    }
  }

  const { data, error } = await svc.rpc("complete_transport_gp_refresh", {
    p_lease_token: leaseToken,
    p_generation_id: generationId,
    p_fetched_at: fetchedAt,
    p_http_status: 200,
  });
  if (error || typeof data !== "number") {
    await discardGeneration(svc, generationId);
    const failure = new GpRefreshFailure(
      "gp_catalog_publish_failed",
      `GP catalog publication failed: ${error?.message ?? "invalid row count"}`,
    );
    await haltRefresh(svc, leaseToken, failure);
    throw failure;
  }
  return data;
}

export async function refreshGpCache(
  svc: SupabaseClient,
  options: GpRefreshOptions = {},
): Promise<GpRefreshResult> {
  const leaseToken = crypto.randomUUID();
  const lease = await acquireLease(svc, leaseToken);
  if (!lease.acquired) {
    return { status: lease.reason, cached: 0 };
  }

  const records = await fetchCatalog(svc, leaseToken, options);
  const cached = await publishCatalog(svc, leaseToken, records);
  logEvent({
    level: "info",
    fn: "transport-sampler",
    event: "gp_refresh",
    msg: `published ${cached} GP elements`,
  });
  return { status: "updated", cached };
}

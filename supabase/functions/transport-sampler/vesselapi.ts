/** VesselAPI REST adapter for the shared vessel-position sampler. */

import {
  classifyByAisType,
  flagFromMmsi,
  isMilitaryAisType,
} from "../_shared/vessel_classify.ts";
import type { VesselPosition } from "./position.ts";

const VESSELAPI_BASE_URL = "https://api.vesselapi.com/v1";
const DEFAULT_TIMEOUT_MS = 10_000;
export const VESSELAPI_PAGE_LIMIT = 50;

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class VesselApiRequestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number | null = null,
  ) {
    super(message);
    this.name = "VesselApiRequestError";
  }
}

export interface VesselApiSample {
  positions: VesselPosition[];
  rowsReceived: number;
  requestedCount: number;
  missingIds: string[];
  hasMore: boolean;
  quotaRemaining: number | null;
  latencyMs: number;
}

interface VesselApiPositionRow {
  mmsi?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  timestamp?: unknown;
  processed_timestamp?: unknown;
  cog?: unknown;
  sog?: unknown;
  heading?: unknown;
  nav_status?: unknown;
  vessel_name?: unknown;
  suspected_glitch?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isoTimestamp(row: VesselApiPositionRow): string | null {
  const raw = typeof row.timestamp === "string"
    ? row.timestamp
    : typeof row.processed_timestamp === "string"
    ? row.processed_timestamp
    : null;
  if (!raw) return null;
  const time = Date.parse(raw);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

export function parseVesselApiPositions(
  body: unknown,
  requestedIds: string[],
): { positions: VesselPosition[]; rowsReceived: number; hasMore: boolean } {
  const requested = new Set(requestedIds);
  const rows = isRecord(body) && Array.isArray(body.vesselPositions)
    ? body.vesselPositions.filter(isRecord) as VesselApiPositionRow[]
    : [];
  const byMmsi = new Map<string, VesselPosition>();

  for (const row of rows) {
    const mmsi = String(row.mmsi ?? "").trim();
    if (!/^\d{9}$/.test(mmsi) || !requested.has(mmsi)) continue;
    if (row.suspected_glitch === true) continue;
    const lat = finite(row.latitude);
    const lon = finite(row.longitude);
    const seenAt = isoTimestamp(row);
    if (
      lat == null || lon == null || seenAt == null || lat < -90 || lat > 90 ||
      lon < -180 || lon > 180
    ) continue;

    const candidate: VesselPosition = {
      mmsi,
      lat,
      lon,
      course: finite(row.cog),
      speedKnots: finite(row.sog),
      heading: finite(row.heading),
      navStatus: finite(row.nav_status),
      shipType: null,
      classification: classifyByAisType(null),
      military: isMilitaryAisType(null),
      name: cleanName(row.vessel_name),
      flag: flagFromMmsi(mmsi),
      seenAt,
    };
    const existing = byMmsi.get(mmsi);
    if (!existing || candidate.seenAt > existing.seenAt) {
      byMmsi.set(mmsi, candidate);
    }
  }

  return {
    positions: [...byMmsi.values()],
    rowsReceived: rows.length,
    hasMore: isRecord(body) && typeof body.nextToken === "string" &&
      body.nextToken.length > 0,
  };
}

function errorCodeFor(status: number, body: unknown): string {
  const providerCode = isRecord(body) && isRecord(body.error) &&
      typeof body.error.code === "string"
    ? body.error.code
    : null;
  if (status === 401) return "vesselapi_auth_failed";
  if (status === 403) return "vesselapi_forbidden";
  if (status === 429) {
    return providerCode === "rate_limit_exceeded"
      ? "vesselapi_quota_or_rate_limited"
      : "vesselapi_rate_limited";
  }
  if (status >= 500) return "vesselapi_upstream_error";
  return "vesselapi_http_error";
}

export async function sampleVesselApiPositions(args: {
  apiKey: string;
  watchIds: string[];
  fetchFn?: FetchLike;
  timeoutMs?: number;
}): Promise<VesselApiSample> {
  const watchIds = [...new Set(args.watchIds)].filter((id) =>
    /^\d{9}$/.test(id)
  );
  if (watchIds.length === 0) {
    return {
      positions: [],
      rowsReceived: 0,
      requestedCount: 0,
      missingIds: [],
      hasMore: false,
      quotaRemaining: null,
      latencyMs: 0,
    };
  }

  const url = new URL(`${VESSELAPI_BASE_URL}/vessels/positions`);
  url.searchParams.set("filter.ids", watchIds.join(","));
  url.searchParams.set("filter.idType", "mmsi");
  url.searchParams.set("pagination.limit", String(VESSELAPI_PAGE_LIMIT));
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const started = performance.now();
  let response: Response;
  let raw: string;
  try {
    response = await (args.fetchFn ?? fetch)(url, {
      headers: { Authorization: `Bearer ${args.apiKey}` },
      signal: controller.signal,
    });
    raw = await response.text();
  } catch {
    const timedOut = controller.signal.aborted;
    throw new VesselApiRequestError(
      timedOut ? "vesselapi_timeout" : "vesselapi_network_error",
      timedOut
        ? "VesselAPI request exceeded its connection deadline"
        : "VesselAPI network request failed",
    );
  } finally {
    clearTimeout(timeout);
  }

  const latencyMs = Math.round(performance.now() - started);
  let body: unknown = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    if (response.ok) {
      throw new VesselApiRequestError(
        "vesselapi_malformed_response",
        "VesselAPI returned non-JSON success output",
        response.status,
      );
    }
  }
  if (!response.ok) {
    throw new VesselApiRequestError(
      errorCodeFor(response.status, body),
      `VesselAPI returned HTTP ${response.status}`,
      response.status,
    );
  }

  const parsed = parseVesselApiPositions(body, watchIds);
  const returned = new Set(parsed.positions.map((position) => position.mmsi));
  const quota = Number.parseInt(
    response.headers.get("x-ratelimit-remaining") ?? "",
    10,
  );
  return {
    ...parsed,
    requestedCount: watchIds.length,
    missingIds: watchIds.filter((id) => !returned.has(id)),
    quotaRemaining: Number.isFinite(quota) ? quota : null,
    latencyMs,
  };
}

/**
 * Browser-assisted Scout CLI authentication.
 *
 * Public: POST /device/authorize, POST /device/token
 * Session JWT: POST /device/lookup, /device/approve, /device/deny
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCors } from "../_shared/cors.ts";
import { type AuthedUser, requireUser } from "../_shared/auth.ts";
import { getServiceClient } from "../_shared/supabase.ts";
import { jsonError, jsonFromError, jsonOk } from "../_shared/responses.ts";
import {
  AuthError,
  RateLimitError,
  ValidationError,
} from "../_shared/errors.ts";
import {
  allowedApprovalOrigin,
  DEVICE_GRANT_TYPE,
  DEVICE_TTL_SECONDS,
  normalizeUserCode,
  noStore,
  POLL_INTERVAL_SECONDS,
  randomUrlToken,
  randomUserCode,
  safeSiteOrigin,
  sanitizeLabel,
  sha256Hex,
} from "./lib.ts";

interface Deps {
  svc?: SupabaseClient;
  requireUserImpl?: (req: Request) => Promise<AuthedUser>;
  now?: () => Date;
}

if (import.meta.main) {
  Deno.serve((req) => handleCliAuthRequest(req));
}

export async function handleCliAuthRequest(
  req: Request,
  deps: Deps = {},
): Promise<Response> {
  const cors = handleCors(req);
  if (cors) return cors;

  const path = new URL(req.url).pathname.replace(/^.*\/cli-auth/, "") || "/";
  const svc = deps.svc ?? getServiceClient();
  try {
    if (path === "/v1/device/authorize" && req.method === "POST") {
      return noStore(
        await createDeviceRequest(req, svc, deps.now?.() ?? new Date()),
      );
    }
    if (path === "/v1/device/token" && req.method === "POST") {
      return noStore(await redeemDeviceRequest(req, svc));
    }
    if (
      ["/v1/device/lookup", "/v1/device/approve", "/v1/device/deny"].includes(
        path,
      ) &&
      req.method === "POST"
    ) {
      const user = await (deps.requireUserImpl ?? requireUser)(req);
      return noStore(await handleBrowserRequest(req, svc, user, path));
    }
    return noStore(
      jsonError("method not allowed", 405, "method_not_allowed", req),
    );
  } catch (error) {
    return noStore(jsonFromError(error, req));
  }
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  if (
    !req.headers.get("content-type")?.toLowerCase().includes("application/json")
  ) {
    throw new ValidationError("application/json required");
  }
  const contentLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 16_384) {
    throw new ValidationError("request body too large");
  }
  try {
    const text = await readBoundedText(req.body, 16_384);
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error();
    }
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError("invalid JSON body");
  }
}

async function readBoundedText(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string> {
  if (!body) return "";

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ValidationError("request body too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function enforceRateLimit(
  svc: SupabaseClient,
  bucket: string,
  action: string,
  limit: number,
  seconds: number,
): Promise<void> {
  const { data, error } = await svc.rpc("consume_cli_auth_rate_limit", {
    p_bucket_hash: await sha256Hex(bucket),
    p_action: action,
    p_limit: limit,
    p_window_seconds: seconds,
  });
  if (error) throw new Error("rate limit check failed");
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.allowed) throw new RateLimitError();
}

function clientBucket(req: Request): string {
  // The nearest trusted proxy appends its observed client to X-Forwarded-For.
  // Taking the last value prevents a caller-controlled first hop from creating
  // unlimited rate-limit buckets.
  const forwarded = req.headers.get("x-forwarded-for")?.split(",").at(-1)
    ?.trim();
  const direct = req.headers.get("x-real-ip")?.trim() ||
    req.headers.get("cf-connecting-ip")?.trim();
  return `cli-auth:${forwarded || direct || "unknown"}`;
}

async function createDeviceRequest(
  req: Request,
  svc: SupabaseClient,
  now: Date,
): Promise<Response> {
  const body = await readJson(req);
  await enforceRateLimit(svc, clientBucket(req), "device_create", 10, 60);

  const clientName = sanitizeLabel(body.client_name, 80) ?? "Scout CLI";
  const agentLabel = sanitizeLabel(body.agent_label ?? body.label, 80);
  const deviceLabel = sanitizeLabel(body.device_label, 120);
  const deviceCode = randomUrlToken(32);
  const userCode = randomUserCode();
  const siteOrigin = safeSiteOrigin(req, body.site_origin);
  const expiresAt = new Date(now.getTime() + DEVICE_TTL_SECONDS * 1000);

  const { error } = await svc.from("cli_device_authorizations").insert({
    device_code_hash: await sha256Hex(deviceCode),
    user_code_hash: await sha256Hex(userCode),
    site_origin: siteOrigin,
    client_name: clientName,
    agent_label: agentLabel,
    device_label: deviceLabel,
    expires_at: expiresAt.toISOString(),
    poll_interval_seconds: POLL_INTERVAL_SECONDS,
  });
  if (error) throw new Error("could not create authorization request");

  const verificationUri = `${siteOrigin}/cli/authorize`;
  return jsonOk(
    {
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: verificationUri,
      verification_uri_complete: `${verificationUri}?user_code=${
        encodeURIComponent(userCode)
      }`,
      expires_in: DEVICE_TTL_SECONDS,
      interval: POLL_INTERVAL_SECONDS,
    },
    201,
    req,
  );
}

async function redeemDeviceRequest(
  req: Request,
  svc: SupabaseClient,
): Promise<Response> {
  const body = await readJson(req);
  if (
    body.grant_type !== DEVICE_GRANT_TYPE ||
    typeof body.device_code !== "string" ||
    body.device_code.length < 32 ||
    body.device_code.length > 256
  ) {
    throw new ValidationError("invalid device grant");
  }
  await enforceRateLimit(svc, clientBucket(req), "device_token", 120, 600);
  await enforceRateLimit(
    svc,
    `cli-auth:device:${await sha256Hex(body.device_code)}`,
    "device_token",
    120,
    600,
  );

  const { data, error } = await svc.rpc("redeem_cli_device_authorization", {
    p_device_code_hash: await sha256Hex(body.device_code),
  });
  if (error) throw new Error("authorization redemption failed");
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error("authorization redemption failed");

  if (row.result !== "created") {
    const status = row.result === "slow_down" ? 429 : 400;
    const response = jsonError(row.result, status, row.result, req);
    if (row.retry_after) {
      response.headers.set("Retry-After", String(row.retry_after));
    }
    return response;
  }

  const { data: account } = await svc.auth.admin.getUserById(row.user_id);
  return jsonOk(
    {
      token_type: "api_key",
      api_key: row.api_key,
      key_id: row.key_id,
      key_prefix: row.key_prefix,
      name: row.key_name,
      account: {
        user_id: row.user_id,
        email: account?.user?.email ?? null,
      },
    },
    200,
    req,
  );
}

async function handleBrowserRequest(
  req: Request,
  svc: SupabaseClient,
  user: AuthedUser,
  path: string,
): Promise<Response> {
  const body = await readJson(req);
  const userCode = normalizeUserCode(body.user_code);
  if (!userCode) throw new ValidationError("invalid user code");

  const userCodeHash = await sha256Hex(userCode);
  await enforceRateLimit(
    svc,
    `cli-auth:user:${user.id}`,
    "browser_action",
    60,
    600,
  );

  const { data: request, error } = await svc
    .from("cli_device_authorizations")
    .select(
      "id, site_origin, client_name, agent_label, device_label, status, expires_at",
    )
    .eq("user_code_hash", userCodeHash)
    .maybeSingle();
  if (error) throw new Error("could not load authorization request");
  if (!request) return jsonError("request not found", 404, "not_found", req);

  if (path === "/v1/device/lookup") {
    const expired = new Date(request.expires_at).getTime() <= Date.now();
    return jsonOk(
      {
        client_name: request.client_name,
        agent_label: request.agent_label,
        device_label: request.device_label,
        site_origin: request.site_origin,
        user_code: userCode,
        status: expired && ["pending", "approved"].includes(request.status)
          ? "expired"
          : request.status,
        expires_at: request.expires_at,
        access: "Read and manage your Scoutpost scouts and reporting data",
      },
      200,
      req,
    );
  }

  if (!allowedApprovalOrigin(req, request.site_origin)) {
    throw new AuthError("unapproved request origin");
  }

  const decision = path.endsWith("/approve") ? "approve" : "deny";
  const { data, error: decisionError } = await svc.rpc(
    "decide_cli_device_authorization",
    {
      p_user_code_hash: userCodeHash,
      p_user_id: user.id,
      p_decision: decision,
    },
  );
  if (decisionError) throw new Error("could not record authorization decision");
  const row = Array.isArray(data) ? data[0] : data;
  if (row?.result === "key_limit_reached") {
    return jsonError(
      "Revoke an existing API key before approving this connection.",
      409,
      "api_key_limit_reached",
      req,
    );
  }
  if (row?.result === "expired") {
    return jsonError(
      "authorization request expired",
      410,
      "expired_token",
      req,
    );
  }
  if (!["approved", "denied"].includes(row?.result)) {
    return jsonError(
      "authorization request is no longer pending",
      409,
      row?.result,
      req,
    );
  }
  return jsonOk({ status: row.result }, 200, req);
}

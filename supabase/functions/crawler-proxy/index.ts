import { z } from "https://esm.sh/zod@3";
import { requireServiceKey, timingSafeEqual } from "../_shared/auth.ts";
import { crawlerProxyErrorEnvelope } from "../_shared/crawler_proxy_contract.ts";
import { validatedCrawlerProxyTenantKey } from "../_shared/crawler_proxy_contract.ts";
import {
  CrawlerProxyError,
  executeCrawlerProxy,
  type ProxyOperation,
  type ProxyWorkloadClass,
} from "../_shared/crawler_workflow_proxy.ts";
import { getServiceClient } from "../_shared/supabase.ts";

const HttpUrl = z.string().max(8192).url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
});
const ScrapeBody = z.object({
  url: HttpUrl,
  timeout_ms: z.number().int().min(1_000).max(120_000).optional(),
  snapshot: z.boolean().optional().default(false),
});
const ParseBody = z.object({ url: HttpUrl });

type ExecuteInput = {
  operation: ProxyOperation;
  url: string;
  timeoutMs: number;
  waitMs: number;
  workloadClass: ProxyWorkloadClass;
  tenantKey: string;
  requestId: string;
  signal?: AbortSignal;
};

interface HandlerDeps {
  scrapeToken?: string;
  serviceAuthorized(req: Request): boolean;
  execute(input: ExecuteInput): Promise<Record<string, unknown>>;
  randomUUID(): string;
}

export async function handleCrawlerProxy(
  req: Request,
  overrides: Partial<HandlerDeps> = {},
): Promise<Response> {
  const route = new URL(req.url).pathname.replace(/\/+$/, "").split("/").pop();
  if (req.method === "GET" && route === "health") {
    return json({ status: "ok", backend: "render-workflows" });
  }
  if (req.method !== "POST" || (route !== "scrape" && route !== "parse")) {
    return detail("not found", 404);
  }

  const deps = handlerDeps(overrides);
  if (!authorized(req, deps)) {
    return detail("invalid or missing bearer token", 401);
  }

  const workloadClass = req.headers.get("x-scoutpost-workload-class");
  if (
    workloadClass !== "scout" && workloadClass !== "utility" &&
    workloadClass !== "system"
  ) {
    return detail("invalid workload class", 422);
  }
  const tenantKey = validatedCrawlerProxyTenantKey(
    req.headers.get("x-scoutpost-tenant-key"),
  );
  if (!tenantKey) return detail("invalid tenant key", 422);

  try {
    const rawBody = await req.json();
    let url: string;
    let timeoutMs: number;
    let operation: ProxyOperation;
    if (route === "scrape") {
      const body = ScrapeBody.parse(rawBody);
      url = body.url;
      timeoutMs = body.timeout_ms ?? 120_000;
      operation = body.snapshot ? "snapshot" : "scrape";
    } else {
      const body = ParseBody.parse(rawBody);
      url = body.url;
      timeoutMs = 120_000;
      operation = "parse_pdf";
    }
    const waitMs = operation === "snapshot"
      ? timeoutMs * 2 + 60_000
      : operation === "parse_pdf"
      ? 260_000
      : timeoutMs + 40_000;
    const abort = new AbortController();
    req.signal.addEventListener("abort", () => abort.abort(), { once: true });
    const requestId = deps.randomUUID();
    return streamJson(
      () =>
        deps.execute({
          operation,
          url,
          timeoutMs,
          waitMs,
          workloadClass,
          tenantKey,
          requestId,
          signal: abort.signal,
        }),
      abort,
      requestId,
    );
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return detail("invalid request", 422);
    }
    if (error instanceof CrawlerProxyError) {
      return detail(error.detail, error.status);
    }
    console.warn("crawler proxy request failed");
    return detail("crawler proxy failed", 500);
  }
}

function handlerDeps(overrides: Partial<HandlerDeps>): HandlerDeps {
  return {
    scrapeToken: Deno.env.get("SCRAPE_SERVICE_TOKEN"),
    serviceAuthorized: (req) => {
      try {
        requireServiceKey(req);
        return true;
      } catch {
        return false;
      }
    },
    execute: (input) => executeCrawlerProxy(getServiceClient(), input),
    randomUUID: () => crypto.randomUUID(),
    ...overrides,
  };
}

function authorized(req: Request, deps: HandlerDeps): boolean {
  const auth = req.headers.get("authorization") ?? "";
  return Boolean(
    deps.scrapeToken &&
      timingSafeEqual(auth, `Bearer ${deps.scrapeToken}`),
  ) || deps.serviceAuthorized(req);
}

function detail(value: unknown, status: number): Response {
  return json({ detail: value }, status);
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function streamJson(
  run: () => Promise<Record<string, unknown>>,
  abort: AbortController,
  requestId: string,
): Response {
  const encoder = new TextEncoder();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Leading JSON whitespace starts the response before Supabase's 150s
      // idle limit without changing what Response.json() parses downstream.
      controller.enqueue(encoder.encode("\n"));
      heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode("\n"));
      }, 10_000);
      run().then(
        (result) => {
          if (!closed) {
            controller.enqueue(encoder.encode(JSON.stringify(result)));
          }
        },
        (error) => {
          const envelope = error instanceof CrawlerProxyError
            ? crawlerProxyErrorEnvelope(error.status, error.detail)
            : crawlerProxyErrorEnvelope(500, "crawler proxy failed");
          if (!closed) {
            controller.enqueue(encoder.encode(JSON.stringify(envelope)));
          }
        },
      ).finally(() => {
        if (heartbeat !== undefined) clearInterval(heartbeat);
        if (!closed) {
          closed = true;
          controller.close();
        }
      });
    },
    cancel() {
      closed = true;
      if (heartbeat !== undefined) clearInterval(heartbeat);
      abort.abort();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "X-Scoutpost-Proxy-Request-Id": requestId,
    },
  });
}

if (import.meta.main) Deno.serve((req) => handleCrawlerProxy(req));

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { CrawlerProxyError } from "../_shared/crawler_workflow_proxy.ts";
import { handleCrawlerProxy } from "./index.ts";

const baseDeps = {
  scrapeToken: "proxy-token",
  serviceAuthorized: () => false,
  randomUUID: () => "00000000-0000-4000-8000-000000000099",
};

function post(path: string, body: unknown, headers: HeadersInit = {}): Request {
  return new Request(
    `https://project.test/functions/v1/crawler-proxy/${path}`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json",
        "x-scoutpost-workload-class": "scout",
        "x-scoutpost-tenant-key": "00000000-0000-4000-8000-000000000003",
        ...headers,
      },
      body: JSON.stringify(body),
    },
  );
}

Deno.test("proxy keeps the scrape-service scrape contract", async () => {
  let seen: unknown;
  const response = await handleCrawlerProxy(
    post("scrape", {
      url: "https://example.test/page",
      timeout_ms: 25_000,
      snapshot: true,
    }),
    {
      ...baseDeps,
      execute: (input) => {
        seen = input;
        return Promise.resolve({ markdown: "ok", source_url: input.url });
      },
    },
  );
  assertEquals(response.status, 200);
  const { signal: _signal, ...seenWithoutSignal } = seen as Record<
    string,
    unknown
  >;
  assertEquals(seenWithoutSignal, {
    operation: "snapshot",
    url: "https://example.test/page",
    timeoutMs: 25_000,
    waitMs: 110_000,
    workloadClass: "scout",
    tenantKey: "00000000-0000-4000-8000-000000000003",
    requestId: "00000000-0000-4000-8000-000000000099",
  });
  assertEquals(
    response.headers.get("x-scoutpost-proxy-request-id"),
    "00000000-0000-4000-8000-000000000099",
  );
});

Deno.test("proxy maps PDF terminal details to the existing parse contract", async () => {
  const response = await handleCrawlerProxy(
    post("parse", { url: "https://example.test/scan.pdf" }),
    {
      ...baseDeps,
      execute: () =>
        Promise.reject(
          new CrawlerProxyError("needs_ocr", 422, {
            error: "needs_ocr",
            pages: 4,
            chars: 12,
          }),
        ),
    },
  );
  assertEquals(response.status, 200);
  assertEquals(
    response.headers.get("x-scoutpost-proxy-request-id"),
    "00000000-0000-4000-8000-000000000099",
  );
  assertEquals(await response.json(), {
    _scoutpost_workflow_error: {
      status: 422,
      detail: { error: "needs_ocr", pages: 4, chars: 12 },
    },
  });
});

Deno.test("proxy fails closed and validates server-owned workload class", async () => {
  const execute = () => Promise.resolve({});
  const unauthorized = await handleCrawlerProxy(
    post("scrape", { url: "https://example.test" }, {
      authorization: "Bearer wrong",
    }),
    { ...baseDeps, execute },
  );
  assertEquals(unauthorized.status, 401);

  const invalidClass = await handleCrawlerProxy(
    post("scrape", { url: "https://example.test" }, {
      "x-scoutpost-workload-class": "customer",
    }),
    { ...baseDeps, execute },
  );
  assertEquals(invalidClass.status, 422);

  const invalidTenant = await handleCrawlerProxy(
    post("scrape", { url: "https://example.test" }, {
      "x-scoutpost-tenant-key": "bad tenant key",
    }),
    { ...baseDeps, execute },
  );
  assertEquals(invalidTenant.status, 422);
});

Deno.test("health reveals no secret and needs no bearer token", async () => {
  const response = await handleCrawlerProxy(
    new Request("https://project.test/functions/v1/crawler-proxy/health"),
    { ...baseDeps, execute: () => Promise.resolve({}) },
  );
  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    status: "ok",
    backend: "render-workflows",
  });
});

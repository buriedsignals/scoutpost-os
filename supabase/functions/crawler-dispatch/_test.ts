import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { RenderWorkflowError } from "../_shared/render_workflows.ts";
import {
  crawlerDispatchPlans,
  createImmediateCrawlerBatch,
  submitCrawlerBatch,
} from "./index.ts";

Deno.test("immediate compatibility dispatch is always a one-job plan", () => {
  assertEquals(crawlerDispatchPlans("immediate", "scrape"), [{
    operation: "scrape",
    batchSize: 1,
    maxBatches: 1,
  }]);
  assertEquals(crawlerDispatchPlans("immediate", "parse_pdf")[0].batchSize, 1);
  assertEquals(crawlerDispatchPlans("immediate", "snapshot")[0].batchSize, 1);
  assertEquals(crawlerDispatchPlans("single", "scrape")[0].batchSize, 20);
});

Deno.test("immediate dispatch forms only the requested proxy job batch", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const svc = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return Promise.resolve({
        data: [{ batch_id: "batch-one", job_ids: [args.p_job_id] }],
        error: null,
      });
    },
  };
  assertEquals(
    await createImmediateCrawlerBatch(
      svc as never,
      "00000000-0000-4000-8000-000000000001",
    ),
    [{ batch_id: "batch-one" }],
  );
  assertEquals(calls, [{
    name: "create_crawler_proxy_batch",
    args: { p_job_id: "00000000-0000-4000-8000-000000000001" },
  }]);
});

function serviceClient() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    client: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return Promise.resolve({ data: true, error: null });
      },
    },
  };
}

Deno.test("definitive Render rejection releases the batch immediately", async () => {
  const svc = serviceClient();
  const outcome = await submitCrawlerBatch(
    svc.client as never,
    "batch-one",
    "reservation-one",
    () => Promise.reject(new RenderWorkflowError("rejected", 429)),
  );

  assertEquals(outcome, "released");
  assertEquals(svc.calls, [{
    name: "release_crawler_batch",
    args: {
      p_batch_id: "batch-one",
      p_reservation_token: "reservation-one",
      p_error: "render rejected task start (429)",
    },
  }]);
});

Deno.test("transport ambiguity keeps the reservation for reconciliation", async () => {
  const svc = serviceClient();
  const outcome = await submitCrawlerBatch(
    svc.client as never,
    "batch-one",
    "reservation-one",
    () => Promise.reject(new RenderWorkflowError("transport")),
  );

  assertEquals(outcome, "ambiguous");
  assertEquals(svc.calls, []);
});

Deno.test("timeout and server failures remain duplicate-safe ambiguities", async () => {
  for (const status of [undefined, 408, 500, 503]) {
    const svc = serviceClient();
    const outcome = await submitCrawlerBatch(
      svc.client as never,
      "batch-one",
      "reservation-one",
      () => Promise.reject(new RenderWorkflowError("ambiguous", status)),
    );
    assertEquals(outcome, "ambiguous");
    assertEquals(svc.calls, []);
  }
});

Deno.test("all definitive client rejections release without provider details", async () => {
  for (const status of [400, 401, 403, 404, 409, 422, 429]) {
    const svc = serviceClient();
    const outcome = await submitCrawlerBatch(
      svc.client as never,
      "batch-one",
      "reservation-one",
      () => Promise.reject(new RenderWorkflowError("provider secret", status)),
    );
    assertEquals(outcome, "released");
    assertEquals(
      svc.calls[0]?.args.p_error,
      `render rejected task start (${status})`,
    );
  }
});

Deno.test("failed release acknowledgement halts further starts", async () => {
  const svc = serviceClient();
  svc.client.rpc = (name: string, args: Record<string, unknown>) => {
    svc.calls.push({ name, args });
    return Promise.resolve({ data: false, error: null });
  };
  const outcome = await submitCrawlerBatch(
    svc.client as never,
    "batch-one",
    "reservation-one",
    () => Promise.reject(new RenderWorkflowError("rejected", 429)),
  );
  assertEquals(outcome, "rejected_unreleased");
});

Deno.test("successful start records the Render task id", async () => {
  const svc = serviceClient();
  const outcome = await submitCrawlerBatch(
    svc.client as never,
    "batch-one",
    "reservation-one",
    () => Promise.resolve("trn-one"),
  );

  assertEquals(outcome, "submitted");
  assertEquals(svc.calls, [{
    name: "mark_crawler_batch_submitted",
    args: {
      p_batch_id: "batch-one",
      p_reservation_token: "reservation-one",
      p_render_task_run_id: "trn-one",
    },
  }]);
});

Deno.test("accepted start with an unrecorded id remains ambiguous", async () => {
  const svc = serviceClient();
  svc.client.rpc = (name: string, args: Record<string, unknown>) => {
    svc.calls.push({ name, args });
    return Promise.resolve({ data: false, error: null });
  };

  const outcome = await submitCrawlerBatch(
    svc.client as never,
    "batch-one",
    "reservation-one",
    () => Promise.resolve("trn-one"),
  );

  assertEquals(outcome, "ambiguous");
  assertEquals(svc.calls[0]?.name, "mark_crawler_batch_submitted");
});

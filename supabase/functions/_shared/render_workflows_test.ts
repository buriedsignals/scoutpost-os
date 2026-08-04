import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  getCrawlerTaskRun,
  RenderWorkflowError,
  startCrawlerTask,
} from "./render_workflows.ts";

function env() {
  Deno.env.set("RENDER_WORKFLOW_API_KEY", "render-secret");
  Deno.env.set("RENDER_CRAWLER_TASK_SLUG", "scoutpost-crawler/crawl_batch");
}

Deno.test("task start uses the official endpoint and positional input", async () => {
  env();
  const original = globalThis.fetch;
  let request: { url?: string; init?: RequestInit } = {};
  globalThis.fetch = (url, init) => {
    request = { url: String(url), init };
    return Promise.resolve(
      new Response(JSON.stringify({ id: "trn-one" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  try {
    assertEquals(await startCrawlerTask("batch-one"), "trn-one");
    assertEquals(request.url, "https://api.render.com/v1/task-runs");
    assertEquals(request.init?.method, "POST");
    assertEquals(JSON.parse(String(request.init?.body)), {
      task: "scoutpost-crawler/crawl_batch",
      input: ["batch-one"],
    });
    assertEquals(
      (request.init?.headers as Record<string, string>).authorization,
      "Bearer render-secret",
    );
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("task start classifies every non-success without response content", async () => {
  env();
  const original = globalThis.fetch;
  try {
    for (const status of [401, 429, 500]) {
      globalThis.fetch = () =>
        Promise.resolve(
          new Response("secret provider body", { status }),
        );
      const error = await assertRejects(
        () => startCrawlerTask("batch"),
        RenderWorkflowError,
        "render task start rejected",
      );
      assertEquals(error.status, status);
      assertEquals(error.message.includes("secret provider body"), false);
    }
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("task start transport ambiguity is sanitized", async () => {
  env();
  const original = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error("URL with secret query"));
  try {
    const error = await assertRejects(
      () => startCrawlerTask("batch"),
      RenderWorkflowError,
      "render task start transport",
    );
    assertEquals(error.message.includes("secret"), false);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("task run read validates current Render status shape", async () => {
  env();
  const original = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({
        id: "trn-one",
        status: "succeeded",
        retries: 0,
        results: [{ processed: 20 }],
      })),
    );
  try {
    const task = await getCrawlerTaskRun("trn-one");
    assertEquals(task.status, "succeeded");
    assertEquals(task.results, [{ processed: 20 }]);
  } finally {
    globalThis.fetch = original;
  }
});

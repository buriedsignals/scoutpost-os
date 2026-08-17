import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyRunError,
  markNotificationResult,
  markRunError,
  markRunStage,
  markRunSuccess,
  shouldIncrementScoutFailure,
} from "./run_lifecycle.ts";
import { ApiError, ValidationError } from "./errors.ts";

function fakeClient() {
  const updates: Array<
    { table: string; values: Record<string, unknown>; id: string }
  > = [];
  const events: Array<{ table: string; values: Record<string, unknown> }> = [];
  const runs: Record<string, Record<string, unknown>> = {
    "run-1": { scout_id: "scout-1", user_id: "user-1" },
  };
  return {
    updates,
    events,
    client: {
      from(table: string) {
        return {
          update(values: Record<string, unknown>) {
            return {
              eq(column: string, id: string) {
                if (column !== "id") {
                  throw new Error(`unexpected column ${column}`);
                }
                updates.push({ table, values, id });
                return { error: null };
              },
            };
          },
          select(_columns: string) {
            return {
              eq(column: string, id: string) {
                if (table !== "scout_runs" || column !== "id") {
                  throw new Error(`unexpected select ${table}.${column}`);
                }
                return {
                  maybeSingle() {
                    return { data: runs[id] ?? null, error: null };
                  },
                };
              },
            };
          },
          insert(values: Record<string, unknown>) {
            events.push({ table, values });
            return { error: null };
          },
        };
      },
    },
  };
}

Deno.test("markRunStage records the current lifecycle stage", async () => {
  const fake = fakeClient();
  await markRunStage(fake.client as never, "run-1", "scrape");
  assertEquals(fake.updates, [{
    table: "scout_runs",
    values: { stage: "scrape" },
    id: "run-1",
  }]);
  assertEquals(fake.events[0].table, "scout_run_events");
  assertEquals(fake.events[0].values.stage, "scrape");
  assertEquals(fake.events[0].values.status, "running");
});

Deno.test("markRunSuccess mirrors diagnostic counts into legacy count columns", async () => {
  const fake = fakeClient();
  await markRunSuccess(fake.client as never, "run-1", {
    unitsCreated: 3,
    unitsMerged: 2,
    criteriaStatus: true,
    notificationStatus: "pending",
    sourcesScraped: 4,
    sourcesFailed: 1,
  });
  const values = fake.updates[0].values;
  assertEquals(values.status, "success");
  assertEquals(values.stage, "finalize");
  assertEquals(values.articles_count, 3);
  assertEquals(values.merged_existing_count, 2);
  assertEquals(values.units_created_count, 3);
  assertEquals(values.units_merged_count, 2);
  assertEquals(values.sources_scraped, 4);
  assertEquals(values.sources_failed, 1);
  assertEquals(values.notification_status, "pending");
  assertEquals(values.error_class, null);
  assertEquals(fake.events[0].values.status, "success");
  assertEquals(fake.events[0].values.notification_status, "pending");
  assertEquals(fake.events[0].values.metadata, {
    units_created_count: 3,
    units_merged_count: 2,
    sources_scraped: 4,
    sources_failed: 1,
    criteria_status: true,
  });
});

Deno.test("markRunError records class, stage, message and terminal status", async () => {
  const fake = fakeClient();
  await markRunError(fake.client as never, "run-1", {
    stage: "credits",
    errorClass: "quota",
    message: "not enough credits",
    status: "skipped",
  });
  const values = fake.updates[0].values;
  assertEquals(values.status, "skipped");
  assertEquals(values.stage, "credits");
  assertEquals(values.error_class, "quota");
  assertEquals(values.error_message, "not enough credits");
  assertEquals(values.notification_status, "not_applicable");
  assertEquals(values.scraper_status, true);
  assertEquals(fake.events[0].values.error_class, "quota");
  assertEquals(fake.events[0].values.status, "skipped");
});

Deno.test("markNotificationResult can record notification failure without changing run status", async () => {
  const fake = fakeClient();
  await markNotificationResult(
    fake.client as never,
    "run-1",
    "failed",
    "Resend 500",
  );
  const values = fake.updates[0].values;
  assertEquals(values.stage, "notify");
  assertEquals(values.notification_status, "failed");
  assertEquals(values.notification_reason, null);
  assertEquals(values.notification_provider_id, null);
  assertEquals(values.error_message, "notification failed: Resend 500");
  assertEquals(fake.events[0].values.status, "success");
  assertEquals(fake.events[0].values.notification_status, "failed");
});

Deno.test("markNotificationResult records provider id and structured reason", async () => {
  const fake = fakeClient();
  await markNotificationResult(fake.client as never, "run-1", "sent", {
    providerId: "email_123",
  });
  assertEquals(fake.updates[0].values.notification_provider_id, "email_123");
  assertEquals(fake.updates[0].values.notification_reason, null);
  assertEquals(fake.events[0].values.metadata, {
    notification_reason: null,
    notification_provider_id: "email_123",
  });

  const failed = fakeClient();
  await markNotificationResult(failed.client as never, "run-1", "failed", {
    reason: "resend_key_missing",
    message: "RESEND_API_KEY is not configured",
  });
  assertEquals(
    failed.updates[0].values.notification_reason,
    "resend_key_missing",
  );
});

Deno.test("classifyRunError distinguishes no-baseline, provider and platform failures", () => {
  assertEquals(
    classifyRunError(
      new ValidationError("page scout has no baseline"),
      "scrape",
    ),
    {
      errorClass: "no_baseline",
      stage: "dispatch",
      message: "page scout has no baseline",
    },
  );
  assertEquals(
    classifyRunError(new ApiError("firecrawl scrape failed", 502), "scrape")
      .errorClass,
    "provider",
  );
  assertEquals(
    classifyRunError(
      new Error("unit insert failed for 3 extracted units"),
      "insert_units",
    )
      .errorClass,
    "platform",
  );
});

Deno.test("renderer capacity exhaustion is a platform failure that cannot auto-pause a scout", () => {
  const classified = classifyRunError(
    new ApiError(
      'crawl4ai scrape failed: 503 {"detail":"scrape capacity exhausted"}',
      502,
    ),
    "scrape",
  );

  assertEquals(classified, {
    errorClass: "platform",
    stage: "scrape",
    message:
      'crawl4ai scrape failed: 503 {"detail":"scrape capacity exhausted"}',
  });
  assertEquals(shouldIncrementScoutFailure(classified.errorClass), false);

  const thirdPartyCollision = classifyRunError(
    new ApiError(
      'firecrawl scrape failed: 503 {"detail":"scrape capacity exhausted"}',
      502,
    ),
    "scrape",
  );
  assertEquals(thirdPartyCollision.errorClass, "provider");
  assertEquals(
    shouldIncrementScoutFailure(thirdPartyCollision.errorClass),
    true,
  );
});

Deno.test("only provider-like failures increment scout failure counters", () => {
  assertEquals(shouldIncrementScoutFailure("provider"), true);
  assertEquals(shouldIncrementScoutFailure("timeout"), true);
  assertEquals(shouldIncrementScoutFailure("unknown"), true);
  assertEquals(shouldIncrementScoutFailure("platform"), false);
  assertEquals(shouldIncrementScoutFailure("no_baseline"), false);
  assertEquals(shouldIncrementScoutFailure("quota"), false);
});

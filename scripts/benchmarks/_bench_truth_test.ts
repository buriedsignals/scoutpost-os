import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  captureContentIssue,
  recentSourceLinkedIssue,
} from "./_bench_truth.ts";

Deno.test("capture truth accepts substantive content and rejects challenge shells", () => {
  assertEquals(
    captureContentIssue("Useful reporting. ".repeat(200), 2_000),
    null,
  );
  assertEquals(
    captureContentIssue("Just a moment... Enable JavaScript and cookies", 20),
    "capture is a recognized challenge/error page",
  );
  assertEquals(
    captureContentIssue("short content", 2_000),
    "capture has 13 chars, expected at least 2000",
  );
  assertEquals(captureContentIssue(null, 2_000), "capture is missing or empty");
});

Deno.test("result truth requires a recent date, source URL, and article-shaped URL", () => {
  const now = new Date("2026-07-13T12:00:00Z");
  assertEquals(
    recentSourceLinkedIssue(
      {
        sourceUrl: "https://example.com/news/london-council-plan",
        occurredAt: "2026-07-10",
      },
      now,
      14,
    ),
    null,
  );
  assertEquals(
    recentSourceLinkedIssue(
      {
        sourceUrl: "https://example.com/news/london-council-plan",
        occurredAt: "2026-06-01",
      },
      now,
      14,
    ),
    "result date is older than 14 days",
  );
  assertEquals(
    recentSourceLinkedIssue(
      { sourceUrl: "https://example.com/news", occurredAt: "2026-07-10" },
      now,
      14,
    ),
    "source URL is not article-shaped",
  );
  assertEquals(
    recentSourceLinkedIssue(
      { sourceUrl: null, occurredAt: "2026-07-10" },
      now,
      14,
    ),
    "source URL is missing or invalid",
  );
  assertEquals(
    recentSourceLinkedIssue(
      {
        sourceUrl: "https://example.com/news/london-council-plan",
        occurredAt: null,
      },
      now,
      14,
    ),
    "result date is missing or invalid",
  );
});

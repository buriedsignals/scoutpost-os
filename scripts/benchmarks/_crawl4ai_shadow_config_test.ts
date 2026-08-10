import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  validateContainerName,
  validateDistinctContainers,
  validateDistinctImages,
  validateImageId,
  validateLoopbackServiceOrigin,
} from "./_crawl4ai_shadow_config.ts";

Deno.test("shadow endpoints are restricted to credential-free loopback origins", () => {
  assertEquals(
    validateLoopbackServiceOrigin("control", "http://127.0.0.1:18089/"),
    "http://127.0.0.1:18089",
  );
  assertEquals(
    validateLoopbackServiceOrigin("candidate", "http://localhost:18092"),
    "http://localhost:18092",
  );
  for (
    const unsafe of [
      "https://127.0.0.1:18089",
      "http://example.com:18089",
      "http://token@127.0.0.1:18089",
      "http://127.0.0.1:18089/scrape",
      "http://127.0.0.1:18089?token=oops",
    ]
  ) {
    assertThrows(() => validateLoopbackServiceOrigin("control", unsafe));
  }
});

Deno.test("shadow container names cannot become Docker options", () => {
  assertEquals(
    validateContainerName("control", "scoutpost-scrape-089-control"),
    "scoutpost-scrape-089-control",
  );
  assertThrows(() => validateContainerName("candidate", "--privileged"));
  assertThrows(() => validateContainerName("candidate", "name with space"));
  assertThrows(() => validateContainerName("candidate", "postgres-primary"));
});

Deno.test("shadow images must use immutable Docker image IDs", () => {
  const imageId = `sha256:${"a".repeat(64)}`;
  assertEquals(validateImageId("control", imageId), imageId);
  assertThrows(() => validateImageId("candidate", "scoutpost-scrape:latest"));
  assertThrows(() => validateImageId("candidate", `sha256:${"g".repeat(64)}`));
});

Deno.test("shadow control and candidate containers must be distinct", () => {
  validateDistinctContainers(
    "scoutpost-scrape-control",
    "scoutpost-scrape-candidate",
  );
  assertThrows(() =>
    validateDistinctContainers(
      "scoutpost-scrape-control",
      "scoutpost-scrape-control",
    )
  );
});

Deno.test("shadow control and candidate images must be distinct", () => {
  validateDistinctImages(
    `sha256:${"a".repeat(64)}`,
    `sha256:${"b".repeat(64)}`,
  );
  assertThrows(() =>
    validateDistinctImages(
      `sha256:${"a".repeat(64)}`,
      `sha256:${"a".repeat(64)}`,
    )
  );
});

// Deno tests for the release download-URL builder.
// These pin the two highest-risk strings in the package: the public repo slug
// and the `scout-v` tag prefix. A wrong slug or prefix 404s every npm install.

import { assertEquals, assertStringIncludes } from "jsr:@std/assert";

import { buildDownloadUrl, RELEASE_TAG_PREFIX, REPO_SLUG } from "./release.js";

Deno.test("buildDownloadUrl targets the public mirror with the scout-v tag", () => {
  assertEquals(
    buildDownloadUrl("scout-darwin-arm64", "0.1.0"),
    "https://github.com/buriedsignals/scoutpost-os/releases/download/scout-v0.1.0/scout-darwin-arm64",
  );
  assertEquals(
    buildDownloadUrl("scout-linux-x86_64", "0.1.0"),
    "https://github.com/buriedsignals/scoutpost-os/releases/download/scout-v0.1.0/scout-linux-x86_64",
  );
});

Deno.test("buildDownloadUrl interpolates arbitrary versions (incl. prereleases)", () => {
  assertStringIncludes(
    buildDownloadUrl("scout-darwin-x86_64", "0.2.1"),
    "/download/scout-v0.2.1/scout-darwin-x86_64",
  );
  assertStringIncludes(
    buildDownloadUrl("scout-linux-arm64", "0.1.0-rc1"),
    "/download/scout-v0.1.0-rc1/scout-linux-arm64",
  );
});

Deno.test("release constants are the expected public-mirror coordinates", () => {
  assertEquals(REPO_SLUG, "buriedsignals/scoutpost-os");
  assertEquals(RELEASE_TAG_PREFIX, "scout-v");
});

import { assertEquals, assertThrows } from "jsr:@std/assert";
import { validateChecksumManifest, validateDownloadURL } from "./release.js";

Deno.test("postinstall accepts only an exact per-version asset digest", () => {
  const digest = "a".repeat(64);
  assertEquals(
    validateChecksumManifest(
      {
        schema_version: "scoutpost-binary-checksums/v1",
        version: "1.2.3",
        publisher_subject: "CN=Indicator Labs",
        assets: { "scout-linux-x86_64": digest },
      },
      "1.2.3",
      "scout-linux-x86_64",
    ).digest,
    digest,
  );
  assertThrows(() =>
    validateChecksumManifest(
      {
        schema_version: "scoutpost-binary-checksums/v1",
        version: "1.2.2",
        assets: { "scout-linux-x86_64": digest },
      },
      "1.2.3",
      "scout-linux-x86_64",
    )
  );
});

Deno.test("postinstall redirects remain HTTPS on pinned release hosts", () => {
  assertEquals(
    validateDownloadURL("https://github.com/buriedsignals/scoutpost-os")
      .hostname,
    "github.com",
  );
  assertEquals(
    validateDownloadURL("https://release-assets.githubusercontent.com/file")
      .hostname,
    "release-assets.githubusercontent.com",
  );
  assertThrows(() => validateDownloadURL("http://github.com/file"));
  assertThrows(() => validateDownloadURL("https://github.com.evil.test/file"));
  assertThrows(() => validateDownloadURL("https://user:pass@github.com/file"));
});

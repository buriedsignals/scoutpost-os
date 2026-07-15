import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import {
  buildSocialProfileUrl,
  classifyProfileProbeStatus,
  isInvalidLinkedInProfileUrl,
  isLinkedInCompanyUrl,
  looksLikeMissingProfileError,
  normalizeSocialHandle,
  resolveSocialProfile,
  socialProfileCandidates,
} from "./social_profiles.ts";

Deno.test("normalizeSocialHandle preserves a bare Instagram handle", () => {
  assertEquals(
    normalizeSocialHandle("instagram", "buriedsignals"),
    "buriedsignals",
  );
});

Deno.test("normalizeSocialHandle strips social profile URLs", () => {
  assertEquals(
    normalizeSocialHandle(
      "instagram",
      "https://www.instagram.com/buriedsignals/",
    ),
    "buriedsignals",
  );
  assertEquals(
    normalizeSocialHandle("x", "https://twitter.com/buriedsignals"),
    "buriedsignals",
  );
  assertEquals(
    normalizeSocialHandle("tiktok", "https://www.tiktok.com/@buriedsignals"),
    "buriedsignals",
  );
});

Deno.test("buildSocialProfileUrl builds canonical URLs from handles", () => {
  assertEquals(
    buildSocialProfileUrl("instagram", "buriedsignals"),
    "https://www.instagram.com/buriedsignals/",
  );
  assertEquals(
    buildSocialProfileUrl("x", "@buriedsignals"),
    "https://x.com/buriedsignals",
  );
});

Deno.test("socialProfileCandidates tries official and .org variants", () => {
  assertEquals(
    socialProfileCandidates("instagram", "bellingcat"),
    ["bellingcat", "bellingcatofficial", "bellingcat.org"],
  );
});

Deno.test("normalizeSocialHandle extracts LinkedIn /in/ profile slugs", () => {
  assertEquals(
    normalizeSocialHandle(
      "linkedin",
      "https://www.linkedin.com/in/satyanadella/",
    ),
    "satyanadella",
  );
  assertEquals(
    normalizeSocialHandle("linkedin", "@satyanadella"),
    "satyanadella",
  );
  assertEquals(
    normalizeSocialHandle("linkedin", "satyanadella"),
    "satyanadella",
  );
});

Deno.test("buildSocialProfileUrl builds LinkedIn personal profile URLs", () => {
  assertEquals(
    buildSocialProfileUrl("linkedin", "satyanadella"),
    "https://www.linkedin.com/in/satyanadella/",
  );
});

Deno.test("socialProfileCandidates probes only the bare handle for LinkedIn", () => {
  assertEquals(
    socialProfileCandidates("linkedin", "satyanadella"),
    ["satyanadella"],
  );
});

Deno.test("isLinkedInCompanyUrl flags company/school/showcase URLs only", () => {
  assertEquals(
    isLinkedInCompanyUrl("https://www.linkedin.com/company/microsoft/"),
    true,
  );
  assertEquals(
    isLinkedInCompanyUrl("linkedin.com/school/eth-zurich/"),
    true,
  );
  assertEquals(
    isLinkedInCompanyUrl("https://www.linkedin.com/in/satyanadella/"),
    false,
  );
  assertEquals(isLinkedInCompanyUrl("satyanadella"), false);
});

Deno.test("LinkedIn URL inputs must be personal /in/ profile URLs", () => {
  assertEquals(
    isInvalidLinkedInProfileUrl("https://www.linkedin.com/in/satyanadella/"),
    false,
  );
  assertEquals(
    isInvalidLinkedInProfileUrl("linkedin.com/in/satyanadella"),
    false,
  );
  assertEquals(
    isInvalidLinkedInProfileUrl("https://www.linkedin.com/feed/"),
    true,
  );
  assertEquals(
    isInvalidLinkedInProfileUrl(
      "https://www.linkedin.com/in/satyanadella/posts/",
    ),
    true,
  );
  assertEquals(isInvalidLinkedInProfileUrl("satyanadella"), false);
});

Deno.test("resolveSocialProfile falls back to input handle on LinkedIn authwall", async () => {
  // LinkedIn answers datacenter probes with HTTP 999 → "uncertain".
  const resolution = await resolveSocialProfile("linkedin", "satyanadella", {
    probe: () => Promise.resolve("uncertain"),
  });
  assertEquals(resolution.adapter_status, "probe_uncertain");
  assertEquals(resolution.resolved_handle, "satyanadella");
  assertEquals(
    resolution.resolved_profile_url,
    "https://www.linkedin.com/in/satyanadella/",
  );
  assertEquals(resolution.attempts.length, 1);
});

Deno.test("resolveSocialProfile picks first existing candidate", async () => {
  const resolution = await resolveSocialProfile("instagram", "bellingcat", {
    probe: (_url, handle) =>
      Promise.resolve(handle === "bellingcatofficial" ? "exists" : "missing"),
  });
  assertEquals(resolution.adapter_status, "resolved");
  assertEquals(resolution.resolved_handle, "bellingcatofficial");
  assertEquals(
    resolution.resolved_profile_url,
    "https://www.instagram.com/bellingcatofficial/",
  );
  assertEquals(resolution.attempts.length, 2);
});

Deno.test("resolveSocialProfile falls back on inconclusive probes", async () => {
  const resolution = await resolveSocialProfile("x", "@bellingcat", {
    probe: () => Promise.resolve("uncertain"),
  });
  assertEquals(resolution.adapter_status, "probe_uncertain");
  assertEquals(resolution.resolved_handle, "bellingcat");
  assertEquals(resolution.attempts.length, 1);
});

Deno.test("classifyProfileProbeStatus keeps anti-bot responses inconclusive", () => {
  assertEquals(classifyProfileProbeStatus(200), "exists");
  assertEquals(classifyProfileProbeStatus(302), "exists");
  assertEquals(classifyProfileProbeStatus(404), "missing");
  assertEquals(classifyProfileProbeStatus(403), "uncertain");
  assertEquals(classifyProfileProbeStatus(429), "uncertain");
});

Deno.test("looksLikeMissingProfileError matches not-found/private failures", () => {
  assertEquals(looksLikeMissingProfileError("Profile not found"), true);
  assertEquals(
    looksLikeMissingProfileError("username does not exist on Instagram"),
    true,
  );
  assertEquals(
    looksLikeMissingProfileError("Apify actor timed out after 120 seconds"),
    false,
  );
});

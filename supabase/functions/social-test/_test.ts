import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleSocialTestRequest } from "./index.ts";

const PROFILE_ACTOR = "dSCLg0C3YEZ83HzYX";
const POSTS_ACTOR = "pmQcv69sB1UwguQUY";
const UNKNOWN_WARNING =
  "Instagram privacy could not be confirmed. Continue only if this is a public profile.";

interface ProviderRequest {
  url: string;
  body: unknown;
}

interface RunOptions {
  platform?: "instagram" | "x";
  handle?: string;
  metadata: () => Response | Promise<Response>;
  posts?: unknown[];
}

async function runSocialTest(options: RunOptions) {
  const platform = options.platform ?? "instagram";
  const handle = options.handle ?? "natgeo";
  const requests: ProviderRequest[] = [];
  const fetchImpl = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const body = init?.body && typeof init.body === "string"
      ? JSON.parse(init.body)
      : undefined;
    requests.push({ url, body });

    if (url.includes(`/acts/${PROFILE_ACTOR}/`)) {
      return await options.metadata();
    }
    if (
      url === `https://www.instagram.com/${handle.toLowerCase()}/` ||
      url === `https://x.com/${handle}`
    ) {
      return new Response("<html></html>", { status: 200 });
    }
    if (url.includes("/run-sync-get-dataset-items")) {
      return Response.json(
        options.posts ?? [{
          shortcode: "POST-1",
          caption: "A public post",
          timestamp: "2026-08-22T10:00:00.000Z",
          displayUrl: "https://example.test/post.jpg",
        }],
      );
    }
    throw new Error(`unexpected provider request: ${url}`);
  };

  const response = await handleSocialTestRequest(
    new Request("https://scoutpost.test/functions/v1/social-test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform, handle }),
    }),
    {
      requireUserImpl: () =>
        Promise.resolve({
          id: "00000000-0000-0000-0000-000000000001",
          token: "test-token",
          authMethod: "session" as const,
        }),
      fetchImpl: fetchImpl as typeof fetch,
      apifyToken: "test-apify-token",
    },
  );

  return { response, body: await response.json(), requests };
}

Deno.test("social-test checks Instagram metadata before the existing probe and posts actor", async () => {
  const { response, body, requests } = await runSocialTest({
    handle: "natgeo",
    metadata: () =>
      Response.json([{
        username: "natgeo",
        private: false,
        fullName: "SECRET-FULL-NAME",
        biography: "SECRET-BIOGRAPHY",
        followersCount: 912345,
      }]),
  });

  assertEquals(response.status, 200);
  assertEquals(body.valid, true);
  assertEquals(body.profile_visibility, "public");
  assertEquals(body.warning, undefined);
  assertEquals(body.post_ids, ["POST-1"]);
  assertEquals(body.preview_posts[0], {
    id: "POST-1",
    text: "A public post",
    timestamp: "2026-08-22T10:00:00.000Z",
  });
  assertEquals(
    requests.map(({ url }) => {
      if (url.includes(PROFILE_ACTOR)) return "metadata";
      if (url.includes("instagram.com")) return "probe";
      if (url.includes(POSTS_ACTOR)) return "posts";
      return "unexpected";
    }),
    ["metadata", "probe", "posts"],
  );
  assertEquals(requests[0].body, {
    usernames: ["natgeo"],
    includeAboutSection: false,
  });
  assertEquals(requests[2].body, {
    instagramUsernames: ["natgeo"],
    maxItems: 20,
  });

  const serialized = JSON.stringify(body);
  assert(!serialized.includes("SECRET-FULL-NAME"));
  assert(!serialized.includes("SECRET-BIOGRAPHY"));
  assert(!serialized.includes("912345"));
  assertEquals(body.profile_metadata, undefined);
});

Deno.test("social-test stops a matching confirmed-private Instagram profile before probe and posts", async () => {
  const { response, body, requests } = await runSocialTest({
    handle: "private-profile",
    metadata: () =>
      Response.json([{
        username: "PRIVATE-PROFILE",
        private: true,
        biography: "SECRET-PRIVATE-BIOGRAPHY",
      }]),
  });

  assertEquals(response.status, 200);
  assertEquals(body.valid, false);
  assertEquals(body.profile_visibility, "private");
  assertEquals(
    body.error,
    "Private Instagram profiles cannot be monitored. Choose a public profile.",
  );
  assertEquals(body.post_ids, []);
  assertEquals(body.preview_posts, []);
  assertEquals(body.posts_data, []);
  assertEquals(requests.length, 1);
  assertStringIncludes(requests[0].url, PROFILE_ACTOR);
  assert(!JSON.stringify(body).includes("SECRET-PRIVATE-BIOGRAPHY"));
});

Deno.test("social-test treats every unusable Instagram metadata result as unknown and continues", async () => {
  const cases: Array<{
    name: string;
    metadata: () => Response | Promise<Response>;
  }> = [
    {
      name: "provider unavailable",
      metadata: () => new Response("unavailable", { status: 503 }),
    },
    {
      name: "provider error",
      metadata: () => Promise.reject(new Error("provider disconnected")),
    },
    {
      name: "malformed JSON",
      metadata: () =>
        new Response("{not-json", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    },
    { name: "empty dataset", metadata: () => Response.json([]) },
    {
      name: "mismatched profile",
      metadata: () =>
        Response.json([{ username: "different-profile", private: true }]),
    },
    {
      name: "missing boolean privacy field",
      metadata: () => Response.json([{ username: "natgeo", private: "false" }]),
    },
  ];

  for (const testCase of cases) {
    const { response, body, requests } = await runSocialTest({
      metadata: testCase.metadata,
    });
    assertEquals(response.status, 200, testCase.name);
    assertEquals(body.valid, true, testCase.name);
    assertEquals(body.profile_visibility, "unknown", testCase.name);
    assertEquals(body.warning, UNKNOWN_WARNING, testCase.name);
    assertEquals(body.post_ids, ["POST-1"], testCase.name);
    assertEquals(requests.length, 3, testCase.name);
    assertStringIncludes(requests[0].url, PROFILE_ACTOR, testCase.name);
    assertStringIncludes(requests[2].url, POSTS_ACTOR, testCase.name);
  }
});

Deno.test("social-test never infers private from empty metadata or posts datasets", async () => {
  const { body, requests } = await runSocialTest({
    metadata: () => Response.json([]),
    posts: [],
  });

  assertEquals(body.valid, true);
  assertEquals(body.profile_visibility, "unknown");
  assertEquals(body.warning, UNKNOWN_WARNING);
  assertEquals(body.post_ids, []);
  assertEquals(requests.length, 3);
});

Deno.test("social-test makes no profile-metadata request for non-Instagram platforms", async () => {
  const { body, requests } = await runSocialTest({
    platform: "x",
    handle: "scoutpost",
    metadata: () => {
      throw new Error("metadata actor must not run");
    },
    posts: [{
      id: "X-POST-1",
      text: "An X post",
      createdAt: "2026-08-22T10:00:00.000Z",
    }],
  });

  assertEquals(body.valid, true);
  assertEquals(body.profile_visibility, undefined);
  assertEquals(body.warning, undefined);
  assertEquals(body.post_ids, ["X-POST-1"]);
  assertEquals(requests.length, 2);
  assertEquals(requests.some(({ url }) => url.includes(PROFILE_ACTOR)), false);
});

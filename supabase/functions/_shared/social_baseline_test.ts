import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { ValidationError } from "./errors.ts";
import {
  buildSocialActorInput,
  diffSocialPosts,
  formatSocialBaselinePosts,
  normalizeSocialDatasetPosts,
  SOCIAL_APIFY_ACTORS,
  socialPostIdentity,
} from "./social_baseline.ts";

function preCutoverCallbackIdentities(posts: unknown): string[] {
  if (!Array.isArray(posts)) return [];
  const identities: string[] = [];
  for (const row of posts) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const post = row as Record<string, unknown>;
    for (
      const field of [
        "id",
        "post_id",
        "shortcode",
        "shortCode",
        "pk",
        "postId",
        "url",
      ]
    ) {
      const value = post[field];
      if (typeof value !== "string" || !value.trim()) continue;
      identities.push(value.trim());
      break;
    }
  }
  return identities;
}

Deno.test("instagram actor uses username input shape", () => {
  assertEquals(SOCIAL_APIFY_ACTORS.instagram.id, "pmQcv69sB1UwguQUY");
  assertEquals(buildSocialActorInput("instagram", "@natgeo"), {
    instagramUsernames: ["natgeo"],
    maxItems: 20,
  });
});

Deno.test("facebook actor uses the current bounded URL textarea input shape", () => {
  assertEquals(
    buildSocialActorInput(
      "facebook",
      "zuck",
      new Date("2026-08-17T12:00:00Z"),
    ),
    {
      endpoint: "profile_posts_by_url",
      urls_text: "https://www.facebook.com/zuck",
      start_date: "2026-07-13",
      end_date: "2026-08-17",
      max_posts: 20,
    },
  );
});

Deno.test("facebook actor rejects multiline targets before paid dispatch", () => {
  assertThrows(
    () => buildSocialActorInput("facebook", "zuck\nhttps://facebook.com/meta"),
    ValidationError,
    "single line",
  );
});

Deno.test("normalizeSocialDatasetPosts accepts current Facebook post_id rows", () => {
  const posts = normalizeSocialDatasetPosts("facebook", [{
    post_id: "facebook-post-1",
    message: "A Facebook post",
    timestamp: "2026-08-16T10:30:00Z",
    image: "https://example.com/facebook.jpg",
  }]);

  assertEquals(posts.length, 1);
  assertEquals(posts[0].id, "facebook-post-1");
  assertEquals(posts[0].text, "A Facebook post");
  assertEquals(posts[0].timestamp, "2026-08-16T10:30:00Z");
  assertEquals(posts[0].imageUrl, "https://example.com/facebook.jpg");
});

Deno.test("normalizeSocialDatasetPosts flattens wrapped actor outputs", () => {
  const posts = normalizeSocialDatasetPosts("instagram", [{
    latestPosts: [
      {
        shortcode: "ABC123",
        caption: "A caption",
        taken_at: 1_714_800_000,
        image: "https://example.com/image.jpg",
      },
    ],
  }]);

  assertEquals(posts.length, 1);
  assertEquals(posts[0].id, "ABC123");
  assertEquals(posts[0].text, "A caption");
  assertEquals(posts[0].url, "https://www.instagram.com/p/ABC123/");
  assertEquals(posts[0].imageUrl, "https://example.com/image.jpg");
});

Deno.test("normalizeSocialDatasetPosts accepts Instagram rows without literal id", () => {
  const posts = normalizeSocialDatasetPosts("instagram", [{
    post_id: "post-1",
    text: "Text field",
    accessibility_caption: "Alt caption",
    postedAt: "2026-05-04T12:00:00Z",
    displayUrl: "https://example.com/display.jpg",
  }]);

  assertEquals(posts.length, 1);
  assertEquals(posts[0].id, "post-1");
  assertEquals(posts[0].text, "Text field");
  assertEquals(posts[0].timestamp, "2026-05-04T12:00:00Z");
});

Deno.test("normalizeSocialDatasetPosts drops placeholder rows", () => {
  assertEquals(
    normalizeSocialDatasetPosts("instagram", [{ noResults: true }]),
    [],
  );
});

Deno.test("linkedin actor uses targetUrls input shape", () => {
  assertEquals(
    SOCIAL_APIFY_ACTORS.linkedin.id,
    "harvestapi~linkedin-profile-posts",
  );
  assertEquals(
    buildSocialActorInput(
      "linkedin",
      "https://www.linkedin.com/in/satyanadella/",
    ),
    {
      targetUrls: ["https://www.linkedin.com/in/satyanadella/"],
      maxPosts: 20,
    },
  );
});

Deno.test("normalizeSocialDatasetPosts accepts harvestapi LinkedIn rows", () => {
  // Fixture mirrors a live harvestapi/linkedin-profile-posts dataset item
  // (fields trimmed), captured 2026-07-06.
  const posts = normalizeSocialDatasetPosts("linkedin", [{
    id: "7478576429031649281",
    entityId: "7478576429031649281",
    content: "Microsoft is just one beneficiary of 250 years of history.",
    postedAt: {
      timestamp: 1783031565912,
      date: "2026-07-02T22:32:45.912Z",
    },
    postImages: [{
      url: "https://media.licdn.com/dms/image/v2/example",
      width: 1080,
      height: 1350,
    }],
    postVideo: { thumbnailUrl: "https://media.licdn.com/video-cover" },
    linkedinUrl:
      "https://www.linkedin.com/posts/bradsmi_microsofta250-ugcPost-7478420839751725057-xoe0",
    type: "post",
  }]);

  assertEquals(posts.length, 1);
  assertEquals(posts[0].id, "7478576429031649281");
  assertEquals(
    posts[0].text,
    "Microsoft is just one beneficiary of 250 years of history.",
  );
  assertEquals(posts[0].timestamp, "2026-07-02T22:32:45.912Z");
  assertEquals(
    posts[0].imageUrl,
    "https://media.licdn.com/dms/image/v2/example",
  );
  assertEquals(
    posts[0].url,
    "https://www.linkedin.com/posts/bradsmi_microsofta250-ugcPost-7478420839751725057-xoe0",
  );
});

Deno.test("linkedin video-only posts fall back to the video thumbnail", () => {
  const posts = normalizeSocialDatasetPosts("linkedin", [{
    id: "1",
    content: "video post",
    postedAt: { date: "2026-07-02T22:32:45.912Z" },
    postImages: [],
    postVideo: { thumbnailUrl: "https://media.licdn.com/video-cover" },
    linkedinUrl: "https://www.linkedin.com/posts/example-1",
  }]);

  assertEquals(posts[0].imageUrl, "https://media.licdn.com/video-cover");
});

Deno.test("normalizeSocialDatasetPosts accepts current TikTok actor rows", () => {
  const posts = normalizeSocialDatasetPosts("tiktok", [{
    aweme_id: "7636022633884142862",
    desc: "A TikTok caption",
    create_time: 1_777_900_127,
    share_url: "https://www.tiktok.com/@natgeo/video/7636022633884142862",
    video: {
      cover: {
        url_list: ["https://example.com/tiktok-cover.jpg"],
      },
    },
  }]);

  assertEquals(posts.length, 1);
  assertEquals(posts[0].id, "7636022633884142862");
  assertEquals(posts[0].text, "A TikTok caption");
  assertEquals(posts[0].timestamp, "2026-05-04T13:08:47.000Z");
  assertEquals(posts[0].imageUrl, "https://example.com/tiktok-cover.jpg");
  assertEquals(
    posts[0].url,
    "https://www.tiktok.com/@natgeo/video/7636022633884142862",
  );
});

Deno.test("socialPostIdentity resolves each platform's stable provider identity", () => {
  const cases: Array<[string, unknown, string | null]> = [
    ["instagram", { id: "numeric-id", shortCode: "IG-CODE" }, "IG-CODE"],
    ["x", { conversationId: "X-CONVERSATION" }, "X-CONVERSATION"],
    ["facebook", { post_id: "FB-POST" }, "FB-POST"],
    ["linkedin", { entityId: "LI-ENTITY" }, "LI-ENTITY"],
    [
      "tiktok",
      { aweme_id: 7636022633884142862n.toString() },
      "7636022633884142862",
    ],
    ["instagram", "already-minimal", "already-minimal"],
    ["x", { id: "  trimmed-id  " }, "trimmed-id"],
    ["facebook", { noResults: true }, null],
    ["linkedin", null, null],
  ];

  for (const [platform, row, expected] of cases) {
    assertEquals(socialPostIdentity(platform, row), expected);
  }
});

Deno.test("socialPostIdentity skips malformed higher-priority aliases", () => {
  const cases: Array<[unknown, string]> = [
    [{ shortcode: true, id: "fallback-from-boolean" }, "fallback-from-boolean"],
    [{ shortcode: [], id: "fallback-from-array" }, "fallback-from-array"],
    [{ shortcode: {}, id: "fallback-from-object" }, "fallback-from-object"],
    [{ shortcode: "\ttrimmed\t", id: "lower-priority" }, "trimmed"],
    [{ shortcode: 42, id: "lower-priority" }, "42"],
  ];

  for (const [row, expected] of cases) {
    assertEquals(socialPostIdentity("instagram", row), expected);
  }
});
Deno.test("socialPostIdentity accepts safe integers and rejects unsafe numbers", () => {
  assertEquals(
    socialPostIdentity("instagram", { shortcode: Number.MAX_SAFE_INTEGER }),
    String(Number.MAX_SAFE_INTEGER),
  );
  assertEquals(
    socialPostIdentity("instagram", {
      shortcode: Number.MAX_SAFE_INTEGER + 1,
      id: "safe-fallback",
    }),
    "safe-fallback",
  );
  assertEquals(
    socialPostIdentity("instagram", { shortcode: 42.5, id: "fraction-fallback" }),
    "fraction-fallback",
  );
});

Deno.test("formatSocialBaselinePosts stores only unique compatibility identities", () => {
  assertEquals(
    formatSocialBaselinePosts([
      {
        id: "post-1",
        text: "caption is runtime-only",
        timestamp: "2026-08-20T00:00:00Z",
        imageUrl: "https://example.com/image.jpg",
        url: "https://example.com/post-1",
      },
      {
        id: "post-1",
        text: "duplicate provider row",
        timestamp: "",
        imageUrl: null,
        url: null,
      },
      {
        id: "post-2",
        text: "",
        timestamp: "",
        imageUrl: null,
        url: null,
      },
    ]),
    [{ id: "post-1" }, { id: "post-2" }],
  );
});

Deno.test("minimal baseline writes remain readable by the pre-cutover callback", () => {
  const baseline = formatSocialBaselinePosts([
    { shortcode: "IG-STABLE", caption: "must not persist" },
    { shortcode: "IG-STABLE", caption: "duplicate" },
    { shortcode: "IG-SECOND", image_url: "https://example.com/private.jpg" },
  ], "instagram");

  assertEquals(baseline, [{ id: "IG-STABLE" }, { id: "IG-SECOND" }]);
  assertEquals(preCutoverCallbackIdentities(baseline), [
    "IG-STABLE",
    "IG-SECOND",
  ]);
  assertEquals(
    diffSocialPosts("instagram", baseline, [
      {
        id: "IG-STABLE",
        text: "current",
        timestamp: "",
        imageUrl: null,
        url: null,
      },
      {
        id: "IG-SECOND",
        text: "current",
        timestamp: "",
        imageUrl: null,
        url: null,
      },
    ]).newPosts,
    [],
  );
});

Deno.test("diffSocialPosts keeps a full-object legacy baseline stable across cutover", () => {
  const current = normalizeSocialDatasetPosts("instagram", [{
    shortcode: "IG-STABLE",
    caption: "Current caption",
    image: "https://example.com/current.jpg",
  }]);

  const result = diffSocialPosts("instagram", [
    {
      shortcode: "IG-STABLE",
      id: "legacy-conflicting-id",
      caption: "Legacy caption",
      image_url: "https://example.com/legacy.jpg",
    },
    { shortcode: "IG-STABLE", caption: "duplicate" },
    { noResults: true },
    null,
  ], current);

  assertEquals(result.newPosts, []);
  assertEquals(result.removedIds, []);
  assertEquals(result.baseline, ["IG-STABLE"]);
  assertEquals(result.shouldReplaceBaseline, true);
});

Deno.test("diffSocialPosts treats an empty baseline as unique new posts", () => {
  const current = [
    {
      id: "new-1",
      text: "first",
      timestamp: "",
      imageUrl: null,
      url: "https://example.com/new-1",
    },
    {
      id: "new-1",
      text: "duplicate",
      timestamp: "",
      imageUrl: null,
      url: "https://example.com/new-1",
    },
    {
      id: "new-2",
      text: "second",
      timestamp: "",
      imageUrl: null,
      url: "https://example.com/new-2",
    },
  ];

  const result = diffSocialPosts("x", [], current);

  assertEquals(result.newPosts.map((post) => post.id), ["new-1", "new-2"]);
  assertEquals(result.removedIds, []);
  assertEquals(result.baseline, ["new-1", "new-2"]);
});

Deno.test("diffSocialPosts reports each removed identity once", () => {
  const result = diffSocialPosts("facebook", [
    "kept",
    { post_id: "removed" },
    { postId: "removed" },
    { message: "malformed legacy row" },
  ], [{
    id: "kept",
    text: "still present",
    timestamp: "",
    imageUrl: null,
    url: null,
  }]);

  assertEquals(result.newPosts, []);
  assertEquals(result.removedIds, ["removed"]);
  assertEquals(result.shouldReplaceBaseline, true);
});

Deno.test("diffSocialPosts applies the exact 20 percent actor-result guard", () => {
  const cases = [
    { previousCount: 5, currentCount: 1, shouldReplace: true },
    { previousCount: 6, currentCount: 1, shouldReplace: false },
    { previousCount: 9, currentCount: 1, shouldReplace: false },
    { previousCount: 9, currentCount: 2, shouldReplace: true },
    { previousCount: 10, currentCount: 2, shouldReplace: true },
  ];

  for (const { previousCount, currentCount, shouldReplace } of cases) {
    const previous = Array.from(
      { length: previousCount },
      (_, index) => `post-${index}`,
    );
    const current = Array.from(
      { length: currentCount },
      (_, index) => ({
        id: `post-${index}`,
        text: "actor row",
        timestamp: "",
        imageUrl: null,
        url: null,
      }),
    );

    const result = diffSocialPosts("linkedin", previous, current);

    assertEquals(
      result.shouldReplaceBaseline,
      shouldReplace,
      `${currentCount}/${previousCount}`,
    );
    assertEquals(
      result.removedIds,
      shouldReplace ? previous.slice(currentCount) : [],
      `${currentCount}/${previousCount}`,
    );
    assertEquals(
      result.baseline,
      shouldReplace ? current.map((post) => post.id) : previous,
      `${currentCount}/${previousCount}`,
    );
  }
});

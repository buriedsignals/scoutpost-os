import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import {
  buildSocialActorInput,
  normalizeSocialDatasetPosts,
  SOCIAL_APIFY_ACTORS,
} from "./social_baseline.ts";

Deno.test("instagram actor uses username input shape", () => {
  assertEquals(SOCIAL_APIFY_ACTORS.instagram.id, "pmQcv69sB1UwguQUY");
  assertEquals(buildSocialActorInput("instagram", "@natgeo"), {
    instagramUsernames: ["natgeo"],
    maxItems: 20,
  });
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
  assertEquals(posts[0].imageUrl, "https://media.licdn.com/dms/image/v2/example");
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

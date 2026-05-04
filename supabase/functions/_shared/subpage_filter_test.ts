import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import {
  filterSubpageUrls,
  hasDeterministicListingSignal,
  isLikelyArticleUrl,
} from "./subpage-filter.ts";

const INDEX = "https://www.example.ch/news/press-releases/";

Deno.test("filterSubpageUrls keeps URLs under the index path", () => {
  const input = [
    "https://www.example.ch/news/press-releases/one",
    "https://www.example.ch/news/press-releases/two",
  ];
  assertEquals(filterSubpageUrls(input, INDEX), input);
});

Deno.test("filterSubpageUrls drops URLs outside the index path", () => {
  const input = [
    "https://www.example.ch/news/press-releases/keep",
    "https://www.example.ch/contact",
    "https://www.example.ch/news/other-section/item",
    "https://www.example.ch/",
  ];
  assertEquals(filterSubpageUrls(input, INDEX), [
    "https://www.example.ch/news/press-releases/keep",
  ]);
});

Deno.test("filterSubpageUrls keeps safe same-host article routes outside the index path", () => {
  const index = "https://www.bzbasel.ch/gemeinde/arlesheim-4144";
  const article =
    "https://www.bzbasel.ch/aargau/fricktal/zeiningen-steiner-logistic-ag-wird-uebernommen-ld.4158147";
  assertEquals(filterSubpageUrls([article], index), [article]);
});

Deno.test("filterSubpageUrls treats www and bare host as the same host", () => {
  const input = [
    "https://example.ch/news/press-releases/one",
    "https://www.example.ch/news/press-releases/two",
  ];
  assertEquals(filterSubpageUrls(input, INDEX), input);
});

Deno.test("filterSubpageUrls rejects cross-host paths even when the path matches", () => {
  const input = [
    "https://other.example.ch/news/press-releases/one",
    "https://evil.test/news/press-releases/two",
  ];
  assertEquals(filterSubpageUrls(input, INDEX), []);
});

Deno.test("filterSubpageUrls rejects static assets under the index path", () => {
  const input = [
    "https://www.example.ch/news/press-releases/app.js",
    "https://www.example.ch/news/press-releases/photo.jpg",
    "https://www.example.ch/news/press-releases/ok",
  ];
  assertEquals(filterSubpageUrls(input, INDEX), [
    "https://www.example.ch/news/press-releases/ok",
  ]);
});

Deno.test("filterSubpageUrls requires a path-segment separator (no prefix-only match)", () => {
  // Path that starts with the same bytes but is a sibling route, not a child.
  const input = ["https://www.example.ch/news/press-releases-archive/2024"];
  assertEquals(filterSubpageUrls(input, INDEX), []);
});

Deno.test("filterSubpageUrls blocks path traversal", () => {
  const input = [
    "https://www.example.ch/news/press-releases/../admin",
    "https://www.example.ch/news/press-releases/%2e%2e/admin",
    "https://www.example.ch/news/press-releases/%2E%2E/admin",
  ];
  assertEquals(filterSubpageUrls(input, INDEX), []);
});

Deno.test("filterSubpageUrls rejects IP hosts and localhost via validateDomain", () => {
  // Path-prefix matches but the host is an IP / localhost → reject.
  const input = [
    "http://127.0.0.1/news/press-releases/leak",
    "http://localhost/news/press-releases/leak",
    "http://169.254.169.254/news/press-releases/leak",
  ];
  assertEquals(filterSubpageUrls(input, INDEX), []);
});

Deno.test("filterSubpageUrls skips unparseable URLs", () => {
  const input = ["not-a-url", "https://www.example.ch/news/press-releases/ok"];
  assertEquals(filterSubpageUrls(input, INDEX), [
    "https://www.example.ch/news/press-releases/ok",
  ]);
});

Deno.test("filterSubpageUrls returns empty when indexUrl is unparseable", () => {
  const input = ["https://www.example.ch/news/press-releases/ok"];
  assertEquals(filterSubpageUrls(input, "not-a-url"), []);
});

Deno.test("filterSubpageUrls tolerates trailing slashes on the index URL", () => {
  const ok = "https://www.example.ch/news/press-releases/item";
  assertEquals(
    filterSubpageUrls([ok], "https://www.example.ch/news/press-releases"),
    [ok],
  );
  assertEquals(
    filterSubpageUrls([ok], "https://www.example.ch/news/press-releases/"),
    [ok],
  );
  assertEquals(
    filterSubpageUrls([ok], "https://www.example.ch/news/press-releases//"),
    [ok],
  );
});

Deno.test("filterSubpageUrls root listings only keep structural article routes and order articles first", () => {
  const input = [
    "https://www.example.ch/register",
    "https://www.example.ch/2026-05-04/council-approves-budget",
    "https://www.example.ch/kundenservice",
    "https://www.example.ch/story/headline-123456",
    "https://www.example.ch/news/today.html",
  ];
  assertEquals(filterSubpageUrls(input, "https://www.example.ch/"), [
    "https://www.example.ch/2026-05-04/council-approves-budget",
    "https://www.example.ch/story/headline-123456",
    "https://www.example.ch/news/today.html",
  ]);
});

Deno.test("isLikelyArticleUrl recognizes only concrete article route shapes", () => {
  assertEquals(
    isLikelyArticleUrl("https://example.ch/aargau/fricktal/story-ld.4158147"),
    true,
  );
  assertEquals(
    isLikelyArticleUrl("https://example.ch/region/2026-05-04/headline"),
    true,
  );
  assertEquals(isLikelyArticleUrl("https://example.ch/news/123456"), true);
  assertEquals(
    isLikelyArticleUrl("https://example.ch/news/headline-123456"),
    true,
  );
  assertEquals(isLikelyArticleUrl("https://example.ch/news/story.html"), true);
  assertEquals(isLikelyArticleUrl("https://example.ch/news/story.php"), true);
  assertEquals(isLikelyArticleUrl("https://example.ch/news/story.aspx"), true);
  assertEquals(isLikelyArticleUrl("https://example.ch/story/ld.4158147"), true);
  assertEquals(isLikelyArticleUrl("https://example.ch/news/contact"), false);
  assertEquals(isLikelyArticleUrl("https://example.ch/news/app.js"), false);
});

Deno.test("hasDeterministicListingSignal requires at least three article candidates", () => {
  const listing = "https://example.ch/news";
  const candidates = [
    "https://example.ch/a/story-ld.1",
    "https://example.ch/a/123456",
    "https://example.ch/a/story.html",
  ];
  assertEquals(
    hasDeterministicListingSignal(listing, candidates.slice(0, 2)),
    false,
  );
  assertEquals(hasDeterministicListingSignal(listing, candidates), true);
  assertEquals(
    hasDeterministicListingSignal(
      "https://example.ch/a/story-ld.1",
      candidates,
    ),
    false,
  );
});

import assert from "node:assert/strict";

const ROOT = new URL("../", import.meta.url);
const PROFILE_ACTOR = "dSCLg0C3YEZ83HzYX";
const POSTS_ACTOR = "pmQcv69sB1UwguQUY";

async function source(path: string): Promise<string> {
  return await Deno.readTextFile(new URL(path, ROOT));
}

function lineContaining(document: string, value: string): string {
  const line = document.split("\n").find((candidate) =>
    candidate.includes(value)
  );
  assert.ok(line, `expected documentation line containing ${value}`);
  return line.toLowerCase();
}

Deno.test("Terms preserve service responsibilities without volatile runtime promises", async () => {
  const terms = (await source("frontend/src/routes/terms/+page.svelte"))
    .toLowerCase();

  assert.match(terms, /social scout[^.\n]*public[^.\n]*profile/);
  assert.match(
    terms,
    /(unknown|cannot confirm|could not confirm)[^.\n]*public profile[^.\n]*warn[^.\n]*continu/,
  );
  assert.match(terms, /you are responsible[^.\n]*platform[^.\n]*terms/);
  assert.doesNotMatch(terms, /\binstagram\b/);
  assert.doesNotMatch(
    terms,
    /(best-effort|best effort)[^.\n]*(privacy|profile|check)|privacy check[^.\n]*(before|collect)/,
  );

  assert.match(terms, /page scout[^.\n]*responsib|responsib[^.\n]*page scout/);
  assert.match(
    terms,
    /civic scout[^.\n]*responsib|responsib[^.\n]*civic scout/,
  );
  assert.doesNotMatch(terms, /robots\.txt/);
  assert.doesNotMatch(terms, /one request per scheduled interval/);
  assert.doesNotMatch(terms, /minimum hourly/);
  assert.doesNotMatch(terms, /civic scouts?[^.\n]*\b2 documents/);
});

Deno.test("public Social docs explain the best-effort unknown fallback", async () => {
  const docs = (await source("frontend/src/routes/docs/+page.svelte"))
    .toLowerCase();

  assert.match(docs, /social scout[^.\n]*public[^.\n]*profile/);
  assert.match(docs, /(best-effort|best effort)[^.\n]*instagram/);
  assert.match(
    docs,
    /(unknown|cannot confirm|could not confirm)[^.\n]*(continue|public profile)/,
  );
  assert.match(docs, /user[^.\n]*responsib|you are responsible/);
});

Deno.test("Social operator docs inventory both Instagram actors by their bounded roles", async () => {
  const featureGuide = await source("docs/features/social.md");
  const apifyGuide = await source("docs/supabase/social-apify.md");

  for (const document of [featureGuide, apifyGuide]) {
    const profileActorLine = lineContaining(document, PROFILE_ACTOR);
    const postsActorLine = lineContaining(document, POSTS_ACTOR);
    assert.match(profileActorLine, /(setup|profile|privacy|metadata)/);
    assert.match(postsActorLine, /(post|scheduled|monitor)/);
  }

  const combined = `${featureGuide}\n${apifyGuide}`.toLowerCase();
  assert.match(combined, /setup-only|setup only/);
  assert.match(combined, /best-effort|best effort/);
  assert.match(combined, /unknown/);
  assert.match(combined, /https:\/\/apify\.com\//);
  assert.match(combined, /actor documentation|actor docs/);
});

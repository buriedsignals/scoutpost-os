# Beat Scout Evaluation Benchmark Spec

Status: local planning spec. Do not treat this as an implemented benchmark yet.

## Why This Exists

The `AI in journalism smoke` scout authenticated and ran after the internal service key sync, but still produced zero units. The worker scraped three pages, including weak or unusable sources:

- a sponsored Bloomberg/ARM page
- a Reuters AI policy article
- a TechCrunch tag page blocked by browser verification

That means the remaining Beat Scout problem is not Vault, cron, or dispatch. It is retrieval/extraction quality. We need a benchmark before changing ranking, source selection, criteria semantics, or extraction prompts.

## Known Issues To Benchmark

1. Broad topic criteria are too easy to mis-handle.
   - Example: "AI companies, AI products, AI policy, AI search, or AI use in journalism and media."
   - Risk: the extraction layer may treat broad examples as mandatory conjunctions instead of alternative relevant angles.

2. Source retrieval can select weak pages.
   - Sponsored pages, tag pages, challenge pages, social/video posts, evergreen explainers, and blocked pages can pass discovery but fail extraction.

3. Domain-priority Beat Scouts need article discovery, not homepage scraping.
   - Example: Engadin priority sources are domains such as `engadinerpost.ch`, `engadin.online`, `suedostschweiz.ch`, and `gr.ch`.
   - Expected behavior: search within those domains and scrape article/document URLs.
   - Bad behavior: scrape bare homepages and extract zero useful units.

4. Reliable vs niche source modes need different targets.
   - Reliable global topic scouts should prefer substantive reporting from established outlets.
   - Niche local scouts should prefer local/regional sources while rejecting tourism/listing pages.

5. Localized Beat Scouts are not one product shape.
   - Country-topic scouts (example: "energy in Sweden") should accept national/regional coverage, official sources, and credible international sources when the article is materially about the country.
   - City/village-topic scouts (example: "Pontresina police") should be much stricter. Zero findings is often the correct output unless the place and topic both appear as primary subjects.
   - Sparse village zeros must be auditable, not treated as failed ingestion.

6. Firecrawl endpoint choice is now part of retrieval quality.
   - v2 search supports `includeDomains`, `excludeDomains`, `categories` including `pdf`, `sources`, geo targeting, and optional scrape content.
   - v2 map supports sitemap modes, search filtering, cache bypass, subdomains, and high URL limits.
   - These should be benchmarked before changing production retrieval defaults.

7. Civic direct PDFs are a Civic Scout requirement only.
   - If a Civic Scout tracked URL is itself a PDF, it must enter the civic document extraction queue.
   - Beat/Page/Social scouts must not be routed through civic promise extraction just because a URL ends in `.pdf`.

## Benchmark Shape

Create a small deterministic eval harness that can run against the shared Beat pipeline without writing production data.

Recommended command shape:

```bash
deno test -A supabase/functions/_shared/beat_pipeline_eval_test.ts
```

The eval should be split into two layers:

1. Retrieval eval
   - Runs query generation, Firecrawl search, date filtering, dedupe, and AI article filtering.
   - Does not scrape full pages.
   - Scores selected URLs and metadata.

2. Extraction eval
   - Uses fixed captured article markdown fixtures.
   - Runs `extractAtomicUnits()`.
   - Scores whether at least one useful unit is extracted when the article is clearly relevant.

Avoid live LLM/search calls in CI by default. Live evals should be opt-in:

```bash
COJO_BEAT_LIVE_EVAL=1 deno test -A supabase/functions/_shared/beat_pipeline_eval_test.ts
```

## Fixture Format

Use JSON fixtures committed under:

```text
supabase/functions/_shared/evals/beat/
```

Suggested file shape:

```json
{
  "id": "ai-journalism-global",
  "scope": "topic",
  "source_mode": "reliable",
  "criteria": "Recent major news about artificial intelligence, generative AI, AI companies, AI products, AI policy, AI search, or AI use in journalism and media. Prefer concrete news articles from reliable sources published recently.",
  "location": null,
  "preferred_language": "en",
  "must_include_any": ["journalism", "media", "newsroom", "publisher", "search", "policy", "regulation", "AI company", "generative AI"],
  "must_exclude_domains": ["sponsored.bloomberg.com"],
  "must_exclude_url_patterns": ["/tag/", "cloudflare", "challenge-platform"],
  "min_selected_urls": 3,
  "min_extracted_units": 1
}
```

## Initial Eval Cases

### 1. AI Journalism Global

Purpose: prevent broad topic scouts from returning zero units when current AI/media/policy news exists.

Input:

- type: `beat`
- scope: `topic`
- source mode: `reliable`
- location: none
- criteria: current `AI in journalism smoke` criteria

Pass conditions:

- selects at least 3 candidate article URLs
- excludes sponsored pages
- excludes tag/category pages unless they resolve to article URLs before extraction
- excludes browser challenge pages
- excludes social/video/community platforms such as Facebook, Reddit, YouTube, LinkedIn, X, Instagram, TikTok
- extracts at least 1 useful unit from at least 1 relevant article fixture
- selector prefers AI+journalism/media/newsroom candidates over generic AI business/policy pages when both exist
- `generic_ai_only_selected_count == 0`
- `compound_topic_selected_count >= 3`

### 2. Country Topic

Purpose: ensure country-level locality is not over-strict.

Input:

- type: `beat`
- scope: `combined`
- source mode: `reliable` or `niche`
- location: Sweden
- criteria/topic: energy, grid, renewables, public services, housing, etc.

Pass conditions:

- accepts credible local-language national/regional sources
- accepts credible English/international sources when the article is materially about the country
- rejects wrong-country same-topic content
- zero findings is allowed only when the audit funnel proves candidates were searched and rejected for clear reasons

### 3. Sparse Village Topic

Purpose: prevent forced ingestion for tiny-place searches.

Input:

- type: `beat`
- scope: `combined`
- source mode: `niche`
- location: Pontresina, Graubuenden, Switzerland
- criteria/topic: police, housing, permits, school, council, etc.

Pass conditions:

- zero selected URLs can be a pass
- rejected candidates must be explainable as missing the village, missing the topic, tourism/listing content, homepage/category pages, or wrong-locality regional noise
- if a candidate explicitly involves both the village and topic, it must survive retrieval filtering for scrape/extraction

### 4. Engadin Domain Priority

Purpose: ensure domain-only priority sources are treated as preferred domains, not homepage URLs.

Input:

- type: `beat`
- scope: `combined`
- source mode: `niche`
- location: Engadin, Graubuenden, Switzerland
- criteria/topic: Engadin tech, media, longevity, relocation signals
- priority sources: `engadinerpost.ch`, `engadin.online`, `suedostschweiz.ch`, `gr.ch`

Pass conditions:

- selected URLs include article/document paths, not only site roots
- at least 2 selected URLs are from configured priority domains
- homepage-only result rate is 0
- blocked/empty page rate is below 25 percent
- benchmark Firecrawl `includeDomains` against explicit `site:` queries before choosing the production retrieval shape

### 5. Broad OR Criteria

Purpose: verify criteria examples are treated as alternative relevant angles unless the user explicitly says all are mandatory.

Fixture examples:

- article about AI policy but not AI products
- article about AI search but not newsroom use
- article about newsroom AI use but not regulation

Pass condition:

- each clearly relevant fixture yields at least 1 unit

### 6. Hard Constraint Criteria

Purpose: avoid over-loosening the extractor.

Fixture examples:

- criteria says "only Switzerland"
- criteria says "exclude press releases"
- criteria says "after 2026-04-01"

Pass condition:

- units that violate explicit hard constraints are rejected

### 7. Local Niche Anti-Tourism

Purpose: protect location scouts from travel/listing pollution.

Input:

- source mode: `niche`
- location: a tourism-heavy region
- criteria: local economy, housing, public services, civic updates

Pass conditions:

- rejects hotel/travel/event-listing pages unless criteria explicitly asks for them
- keeps local civic/regional reporting

### 8. Civic Direct PDF

Purpose: ensure direct tracked PDF URLs are processed by the Civic Scout document extraction path.

Input:

- type: `civic`
- tracked URL: direct `.pdf` meeting minutes / protocols

Pass conditions:

- direct PDF URL is inserted into `civic_extraction_queue`
- repeat run does not duplicate queue work if the PDF is already processed
- zero units is allowed only after the PDF extraction worker actually processed the document
- this acceptance target is Civic Scout only; Beat/Page/Social scouts do not enter the civic queue
- direct PDF detection benchmark covers representative municipal URL shapes from at least US, Germany, France, and Switzerland

## Metrics

Track per eval case:

- `selected_url_count`
- `rejected_url_count`
- `rejection_reason_counts`
- `priority_domain_url_count`
- `homepage_url_count`
- `blocked_page_count`
- `social_platform_count`
- `sponsored_page_count`
- `tag_page_count`
- `tourism_page_count`
- `compound_topic_selected_count`
- `generic_ai_only_selected_count`
- `locality_rejected_count`
- `scrape_success_count`
- `extracted_unit_count`
- `criteria_filtered_zero_count`
- `new_unit_count`
- `merged_existing_count`
- `civic_direct_pdf_queued_count`
- `firecrawl_credits_used`

## Firecrawl Endpoint Audit

Keep a live, credit-spending operator audit separate from deterministic CI.

Recommended command shape:

```bash
set -a; source .env; set +a
deno run --allow-env --allow-net scripts/audit-firecrawl-endpoints.ts
```

Endpoint permutations to compare:

- `search` with `includeDomains` for priority-domain scouts
- `search` with explicit `site:` queries for the same domains
- `search` with `categories: ["pdf"]` for civic/public-document discovery
- `map` with `search`, `sitemap`, `includeSubdomains`, `ignoreQueryParameters`, and geo/language hints for civic sites
- optional `search` with `scrapeOptions` only after URL-level filtering, not as a broad default

## Acceptance Target Before Shipping A Beat Pipeline Change

A Beat Scout retrieval/extraction change should not ship unless:

- AI Journalism Global: at least 1 extracted unit from fixture extraction and at least 3 acceptable selected URLs in live eval.
- Country Topic: accepts valid country-specific sources and rejects wrong-country drift.
- Sparse Village Topic: zero findings may pass when rejection reasons prove no candidate matched both place and topic.
- Engadin Domain Priority: 0 homepage-only priority results and at least 2 priority-domain article/document URLs.
- Broad OR Criteria: all clearly relevant OR-angle fixtures produce at least 1 unit.
- Hard Constraint Criteria: explicit hard constraints remain enforced.
- Civic Direct PDF: direct tracked PDFs enter civic extraction and zero units are only accepted after extraction actually ran.
- No eval case regresses from the previous baseline without an intentional explanation in the PR.

## Production Smoke Policy

Production smokes are useful but insufficient.

Use production smokes only to verify:

- authentication works
- the deployed worker starts
- URLs selected by the live pipeline are plausible
- runs reach a terminal state

Do not use a single production smoke as proof that Beat Scout quality is fixed. The benchmark above is the quality gate.

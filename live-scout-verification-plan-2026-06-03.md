# Live Scout Verification Plan - June 2026

Date prepared: 2026-06-03  
Friday verification date: 2026-06-05  
Account: the configured `scout` CLI account on this machine

This file tracks real Scoutpost scouts created for live verification. All
information units remain unverified leads until a human verifies them. Every
Friday check must record source URLs, verification state, and any contradiction
between units instead of resolving the contradiction silently.

## Non-Live Checks Already Run

These checks do not create scouts or spend Scoutpost credits.

| Check | Result | Notes |
| --- | --- | --- |
| `deno run --allow-env scripts/benchmark-qa-matrix.ts` | Pass | 1 passed, 19 skipped because live evidence was unavailable. |
| `deno run --allow-read scripts/benchmark-beat-offline.ts` | Pass | Deterministic Beat/Civic retrieval-quality gate passed. |
| `deno test supabase/functions/_shared/ --allow-env` | Pass | 249 passed, 1 ignored. |
| `deno task test` in `mcp/` | Pass | 19 passed. |
| `deno task test` in `cli/` | Pass | 22 passed, 4 ignored, after allowing Deno to fetch JSR dependencies. |
| `npm run check` in `frontend/` | Pass | 0 Svelte errors, 0 warnings. |
| `npm run test -- --run` in `frontend/` | Pass | 262 passed. |
| `backend/.venv/bin/python -m pytest tests/unit/ -q` | Pass | 514 passed, 2 skipped. Use the venv, not system Python 3.9. |

Known pre-existing failure not rerun here: `supabase/functions/openapi-spec/_test.ts`
still expects old `coJournalist API` branding and is tracked in GitHub issue #212.

## Credit Budget

Creating scheduled live scouts establishes baselines and may use provider quota.
The Friday scheduled run will spend Scoutpost credits when it executes.

| Scout | Per Friday run |
| --- | ---: |
| Page Scout | 1 credit |
| Beat Scout | 7 credits |
| Social Scout, X | 2 credits |
| Social Scout, Instagram | 2 credits |
| Civic Scout | 10 credits, refunded if no documents are queued |
| Total scheduled Friday run | Up to 22 credits |

Manual Friday reruns using `scout scouts run <id>` will spend the same amount
again. If all five scouts are manually rerun after the scheduled run, budget up
to another 22 credits.

## Scout Creation Commands

The names intentionally include the date so they are easy to find and clean up.
`--day 5` means Friday for weekly schedules.

### Page Scout

Purpose: verify baseline creation, Friday change detection, source URL
attribution, and that a quiet source does not create noisy duplicate units.

```bash
scout scouts add \
  --name "qa-20260603-page-basel-media-releases" \
  --type web \
  --url "https://www.baselland.ch/politik-und-behorden/regierungsrat/medienmitteilungen" \
  --topic "basel,policy" \
  --criteria "New official media releases, policy decisions, appointments, consultations, deadlines, or budget/spending commitments from the Basel-Landschaft government." \
  --regularity weekly \
  --day 5 \
  --time 09:00
```

Expected behavior:

- Creation succeeds and stores a baseline.
- Friday run either creates source-linked units for new releases or cleanly
  reports zero new units without creating duplicates.
- Any unit source URL should be the exact release page or the monitored index
  when no deeper page can be resolved.

Desired verification:

- Compare units with the live Baselland media releases page.
- Confirm each statement is atomic, source-linked, and unverified by default.
- Reject units that are only page chrome, navigation, or duplicate old releases.

### Beat Scout

Purpose: verify topic/location discovery, source quality filtering, dedupe, and
that the beat path produces useful local leads without drifting into generic
housing coverage.

```bash
scout scouts add \
  --name "qa-20260603-beat-zurich-housing" \
  --type beat \
  --topic "housing,zurich" \
  --criteria "Zurich housing policy, rents, public housing, zoning, tenants, evictions, construction decisions, budget decisions, or city/cantonal housing measures. Prefer official, local, and beat-relevant sources over generic market commentary." \
  --location-json '{"displayName":"Zurich, Switzerland","latitude":47.3769,"longitude":8.5417,"city":"Zurich","country":"Switzerland","countryCode":"CH","locationType":"city"}' \
  --source-mode reliable \
  --priority-sources "stadt-zuerich.ch,zh.ch" \
  --regularity weekly \
  --day 5 \
  --time 09:10
```

Expected behavior:

- Creation succeeds and stores the scheduled scout.
- Friday run finishes successfully and records candidate sources, failures, and
  inserted or merged units.
- Units should remain on the Zurich housing beat and avoid generic real-estate
  SEO/listing pages.

Desired verification:

- Search/list units for the scout and inspect source URLs before verification.
- Compare a sample against the source page and confirm location relevance.
- Verify only units with explicit support in the cited source.

### Social Scout - X

Purpose: stress the X actor path, baseline post storage, new-post diffing, and
criteria matching for civic/political social monitoring.

```bash
scout scouts add \
  --name "qa-20260603-social-x-sadiqkhan" \
  --type social \
  --topic "london,mayor" \
  --platform x \
  --handle "SadiqKhan" \
  --monitor-mode criteria \
  --criteria "Posts announcing London policy, transport, housing, policing, climate, city services, public safety, budgets, or official commitments. Ignore routine greetings, generic campaign slogans, and engagement bait." \
  --track-removals true \
  --regularity weekly \
  --day 5 \
  --time 09:20
```

Expected behavior:

- Creation validates the profile and stores baseline posts.
- Friday run produces units only for posts newer than the baseline or records a
  clean zero-new-post run.
- Deletion/removal tracking is enabled and should surface removed baseline posts
  if the platform actor reports them.

Desired verification:

- Manually compare with the public X profile around the Friday run time.
- Confirm post URLs are preserved and unit statements do not overstate short
  social posts.
- Treat all social units as leads until source text and context are checked.

### Social Scout - Instagram

Purpose: stress the Instagram actor path and image-heavy post normalization
separately from X.

```bash
scout scouts add \
  --name "qa-20260603-social-instagram-natgeo" \
  --type social \
  --topic "environment,wildlife" \
  --platform instagram \
  --handle "natgeo" \
  --monitor-mode criteria \
  --criteria "Posts with substantive claims or updates about wildlife, conservation, climate, science, environment, expeditions, or named places. Ignore pure promotion, generic image captions, and engagement prompts." \
  --track-removals true \
  --regularity weekly \
  --day 5 \
  --time 09:30
```

Expected behavior:

- Creation validates the profile and stores baseline posts.
- Friday run detects only posts newer than the baseline and keeps source URLs.
- Captions and post metadata should normalize without inventing image-only facts.

Desired verification:

- Manually compare against the public Instagram profile or an external scrape.
- Verify only caption-supported statements, not inferred visual content.
- Check that duplicates from carousel/reshared content are not surfaced as
  separate facts unless they contain distinct claims.

### Civic Scout

Purpose: stress the Civic Scout path the user cares about most: listing-page
tracking, PDF/document discovery, promise extraction, queue processing, and
source URL fidelity.

```bash
scout scouts add \
  --name "qa-20260603-civic-basel-protocols" \
  --type civic \
  --topic "civic,basel" \
  --root-domain "grosserrat.bs.ch" \
  --tracked-urls "https://grosserrat.bs.ch/ratsbetrieb/protokolle-videos?all=1" \
  --criteria "Council decisions, motions, promises, spending commitments, deadlines, votes, procedural decisions, public-service commitments, and named accountability items from Basel-Stadt Grand Council protocols." \
  --regularity weekly \
  --day 5 \
  --time 09:40
```

Expected behavior:

- Creation succeeds and stores tracked URLs and a baseline.
- Friday run uses change tracking, discovers new civic documents if present,
  queues up to the configured per-run document limit, and refunds the 10 credits
  if no documents are queued.
- Extracted promises must preserve source document URLs and should remain
  unverified until checked.

Desired verification:

- Compare discovered documents against the Basel-Stadt protocols listing.
- For any extracted promise, open the source PDF/page and confirm the promise,
  date, actor, and due-date confidence.
- Reject prompt-injection, boilerplate, signatures, agenda-only items, or
  unsupported inferred promises.

## Friday Check Procedure

Run these after the scheduled Friday runs complete. Replace `<id>` with the
created scout IDs recorded from creation output.

```bash
scout scouts show <page-id>
scout scouts show <beat-id>
scout scouts show <social-x-id>
scout scouts show <social-instagram-id>
scout scouts show <civic-id>

scout units list --scout <page-id> --limit 20
scout units list --scout <beat-id> --limit 20
scout units list --scout <social-x-id> --limit 20
scout units list --scout <social-instagram-id> --limit 20
scout units list --scout <civic-id> --limit 20
```

Manual reruns, if needed:

```bash
scout scouts run <social-x-id>
scout scouts run <social-instagram-id>
scout scouts run <civic-id>
```

External comparison sources:

- Use `firecrawl scrape` for public web pages/PDF listing pages in this repo's
  workflow, not ad hoc page fetching.
- Use platform-visible profile pages or the deployed actor preview where needed
  for social comparison.
- Do not mark any unit verified until the source URL directly supports the
  statement.

## Results Log

Fill this in after creation and Friday verification.

| Scout | ID | Created | Friday run status | Units | Verification notes |
| --- | --- | --- | --- | ---: | --- |
| Page |  |  |  |  |  |
| Beat |  |  |  |  |  |
| Social X |  |  |  |  |  |
| Social Instagram |  |  |  |  |  |
| Civic |  |  |  |  |  |

# Adversarial QA scouts — 2026-05-24

Purpose: exercise the failure modes that the offline test matrix can't reach.
Real third-party content, real Firecrawl/Exa/Apify behavior, real credits.
Two-to-three-day soak, then re-scrape the source URLs manually with `firecrawl`
and diff the extracted units against the live page.

All scouts created on the production CLI account
(`c6ac7e0c-35fd-48d0-9b76-7eb7acd48f2c`, Pro tier, 890 credits at start).

## Observed bug at creation time (already a finding)

`scouts add` for `qa-beat-muestair-tiny` and `qa-beat-zurich-german-policy`
returned `API error 502: [object Object]` on the first call. The scouts were
actually created — the retry returned `409: scout name already exists`.

Two real issues hiding behind that:

1. **The 502 is reported as `[object Object]`** — the CLI is not unwrapping the
   error body. Fix: `cli/lib/client.ts` should serialize unknown error bodies
   with `JSON.stringify`, not coerce to string.
2. **The Edge Function returns 502 after a successful insert** — likely the
   downstream `schedule_scout` RPC or notification step throws after the row is
   committed, and the catch surfaces a generic 502. Worth log-diving: search
   `scouts` function logs for the two creation timestamps below.

Both happened on beat-type scout creates with a `location-json` payload, not on
web/social/civic. Hypothesis: `schedule_scout` RPC for beat scouts touches a
slower code path that intermittently times out.

## Scout + run IDs (for verification)

| Scout | Scout ID | First run ID |
|---|---|---|
| qa-web-hn-reorder | `3eeb087d-54cb-496d-9ed2-5cdde75df5ea` | `71986ea1-a412-47cc-b806-64a009e01d38` |
| qa-web-guardian-consent | `0aa6c28a-607a-4ab8-9e7a-8fb75adf9087` | `be541127-4c09-416a-81e8-a8ed8424db56` |
| qa-web-bloomberg-paywall | `ebdf3c89-8d7e-45bf-ad97-726e015da685` | `63baf6d9-98ba-41d6-a996-45f08073624a` |
| qa-beat-muestair-tiny | `8d80c589-ba7c-4d0e-a55d-209d5aa71eb7` | `4bb1ecd7-f59a-4da0-816f-9a24857a568d` |
| qa-beat-zurich-german-policy | `41dea221-6048-4afb-ae57-2d4500c54404` | `78e73243-e3bd-4b50-ae8c-a4c4416de027` |
| qa-social-x-highvol-nytimes | `5ff4cf36-1b29-4c29-b636-ccb47dcb246f` | `1f767147-93f9-45f6-9d48-6ff4cd1f14dd` |
| qa-social-tiktok-thetimes | `255bfdba-d848-4e81-80cf-feaf654546e1` | `379d2009-446b-4213-8318-bf0a586ac814` |
| qa-civic-stadt-zurich | `dde53311-3512-4ce5-9107-0fb6d6d620f7` | `04c80083-b423-4f87-9ffd-a21173cd66f9` |

All triggered 2026-05-24 ~22:17 UTC. Webs are daily-scheduled, beats + civic
weekly, so by the verification date (2026-05-27) the daily scouts will have
fired ~3 times and the weekly ones will have only the initial run plus
whatever was scheduled by `pg_cron`.

## Scout matrix

| # | Type | Name | Target | What bug surface this hits |
|---|---|---|---|---|
| 1 | web | qa-web-hn-reorder | `https://news.ycombinator.com/` | Front page has stable items but reorders every few minutes. Canonical hash should track *content* not *order/score*. Predicted failure: hash flips every run → notifications every cycle even though nothing was substantively added. |
| 2 | web | qa-web-guardian-consent | `https://www.theguardian.com/world` | Heavy consent banner + region routing + dynamic recirculation modules. Predicted failure: Firecrawl scrape captures the consent gate instead of content; canonical hash stabilizes on noise; or the markdown contains a giant ad/related-stories tail that drowns the article. |
| 3 | web | qa-web-bloomberg-paywall | `https://www.bloomberg.com/news/articles/2026-05-24` (or a specific recent article URL) | Hard paywall. Predicted failure: Firecrawl returns either a 403, a half-page teaser, or a marketing shell. Criteria analysis should *not* claim a match on the teaser. If it does, that's a false-positive surface area. |
| 4 | beat | qa-beat-muestair-tiny | location: "Müstair, Switzerland" (population ~750), criteria: "any local news" | Sparse Exa/Firecrawl coverage → tests Exa low-coverage fallback to Firecrawl, then 3-consecutive-low-coverage auto-flip to `retrieval=firecrawl` in `scouts.metadata`. Predicted failure: locality filter is too tight and rejects valid Engadin-region coverage; or Exa returns generic Swiss news mis-tagged as Müstair. |
| 5 | beat | qa-beat-zurich-german-policy | location: "Zürich, Switzerland", criteria: "Stadtrat Sozialpolitik Migrationsamt" (German policy terms) | German-language criteria against Beat pipeline that defaults to English semantics. Predicted failure: extractive summary/criteria filter drops German hits because the LLM scoring prompt is English-anchored, or hits get summarized in English losing nuance. |
| 6 | social | qa-social-x-highvol | platform: x, handle: `@nytimes` | High-volume X account (~50 posts/day). Tests Apify pagination + diff cutoff + criteria filtering at scale. Predicted failure: diff baseline is too small → next run sees "new" posts that were just below the page-1 boundary previously (false positives); or run hits Apify per-call cost ceiling. |
| 7 | social | qa-social-tiktok-thetimes | platform: tiktok, handle: `@thetimes` | TikTok pipeline is the rate-limit-prone path. Predicted failure: Apify TikTok actor times out or returns truncated results; second-run baseline drift triggers spurious "removed" notifications. |
| 8 | civic | qa-civic-stadt-zurich | root_domain: `stadt-zuerich.ch`, tracked URLs: `https://www.stadt-zuerich.ch/de/politik-und-verwaltung/stadtrat/sitzungen-und-geschaeftsverzeichnis.html` | German civic site with PDF agendas. Predicted failure: promise extraction misfires on German agenda items, treats meeting-procedure language ("Bewilligung wird erteilt") as policy promises; or PDF parser truncates long agendas. |

## Expected bugs to verify in 2-3 days

Listed in priority of "this would actually be a real bug worth filing":

1. **`qa-web-hn-reorder`** — if every run notifies, canonical hash is order-sensitive. Fix would live in `_shared/web_content_canonical.ts` (need to strip rank/score artifacts before hashing).
2. **`qa-beat-muestair-tiny`** — if `metadata.retrieval` flips to `firecrawl` after 3 low-coverage Exa runs, the fallback path works. If it doesn't flip but Exa keeps returning <2 hits, the auto-flip logic is broken.
3. **`qa-beat-zurich-german-policy`** — if returned units are all English machine translations of German source headlines, the multilingual handling is poor. Expected acceptable: German source quoted in original, English-language extractive summary.
4. **`qa-social-x-highvol`** — count `units_created` vs Apify dataset item count. A gap > 20% means filtering is too aggressive *or* dedup is bucketing distinct posts.
5. **`qa-social-tiktok-thetimes`** — check for run rows in `removed_unit_ids` that shouldn't be removed. Stale-baseline bug class was fixed in PR #190 (Civic) but Social TikTok wasn't in scope.
6. **`qa-civic-stadt-zurich`** — sampling the extracted promises against the live PDF agenda. False-positive rate >30% would be a bug.
7. **`qa-web-bloomberg-paywall`** — confirms criteria analysis treats paywall teasers as a non-match. If it returns matches, the criteria prompt isn't paywall-aware.
8. **`qa-web-guardian-consent`** — if the captured markdown is mostly nav/consent/ads, canonical hash is comparing noise. Check capture length vs visible-text length of a manual firecrawl.

## Verification protocol (2-3 days later)

For each scout:

1. `scout scouts show <id>` — pull current state, `last_run_at`, `consecutive_failures`.
2. List recent runs via the Edge Function (`/runs?scout_id=…`) — count how many fired in 48h and how many produced notifications.
3. `scout units list --scout <id>` — sample 5 units, read their `source_url` + `statement` + `summary`.
4. For each sampled unit: `firecrawl scrape <source_url>` → diff the captured markdown against what the unit summarized. Flag hallucinations, missed key facts, paywall artifacts.
5. For web scouts: `firecrawl scrape <scout url>` and compare canonical content against the most recent `raw_captures` row's canonical_hash + content (read via SQL).
6. Write findings into `docs/operations/qa-adversarial-scouts-results-2026-05-2X.md` with one section per scout: outcome, bug filed (if any), retention recommendation.

## Cleanup

These scouts are QA artifacts — pause or delete them after the verification
pass to stop them from consuming credits on the next cycle. Document the
dispose decision in the results doc.

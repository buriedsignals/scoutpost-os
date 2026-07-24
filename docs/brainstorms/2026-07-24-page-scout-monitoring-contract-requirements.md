---
date: 2026-07-24
topic: page-scout-monitoring-contract
---

# Page Scout Monitoring Contract

## Summary

A Page Scout has two alert modes:

1. **Any Change:** alert when normalized content at the configured URL, or at
   an in-scope child of a genuine index page, changes after its baseline.
2. **Specific Changes:** alert only when the actual before/after content change
   at one of those URLs matches the user's criteria.

Information-unit extraction may explain a change and populate the inbox. It
does not decide whether an Any Change alert is eligible, and unit
deduplication does not decide whether either alert mode is eligible.

This is a regression repair using the existing Page Scout pipeline. It is not a
new crawler, scope-mode product, membership platform, or notification system.

---

## Audit and History

The HYROX Basel scout was configured for:

`https://hyroxdach.com/de/event/hyrox-basel/`

Its invalid run created 23 units from four unrelated sibling/navigation pages:

- `/de/race-for-impact-charity-tickets`
- `/de/die-hyrox-familie`
- `/de/das-fitness-race`
- `/de/finde-dein-race`

The history identifies two narrow defects:

- Commit `6b0d889a` filtered Phase B links to strict descendants of the
  configured URL. Commit `21dc2d41` added an exception for same-host,
  article-looking URLs outside that subtree. Commit `a967133a` then classified
  long, three-word slugs as article-like. The HYROX navigation URLs pass that
  exception. Commit `e2ba332b` merged rendered-HTML and markdown links, making
  such navigation candidates more likely to enter listing detection.
- Commit `6fa68ecb` restored Any Change notifications in the common case, but
  `shouldSendPageScoutAlert` still requires a newly inserted unit and a
  generated summary. Commit `165c762a` already made normalized-content
  comparison independent of extraction, so notification eligibility is still
  attached to the wrong downstream signal.

The pre-cutover `scout_service.py` used `analysis.matches` to decide Specific
Changes before optional information-unit extraction. It also asked that same
LLM call to generate a summary, but the summary was presentation data rather
than the criteria decision. The repair preserves the match-first behavior while
removing generated descriptions from the eligibility contract.

The repair should restore strict scope and connect alert eligibility to the
existing content-comparison and criteria results.

---

## Product Contract

### URL scope

- The configured URL is always monitored.
- When the configured page is automatically detected as an index, Page Scout
  may follow only HTTP(S) links on the same normalized host whose path is a
  strict path-segment descendant of the configured URL.
- For a configured root path `/`, non-root same-host paths are descendants.
- Parent paths, sibling paths, other subdomains, and same-host article-looking
  URLs outside the configured subtree are out of scope. When rendered HTML
  exposes structural landmarks, global navigation and footer links are removed
  before discovery. Markdown-only/provider-shell fallback cannot reliably
  recover DOM provenance, so it may retain strict descendants; fetched pages
  must still pass document-shape checks before creating a baseline or unit.
- Child following remains one hop and uses the existing Phase B fetch cap and
  execution budget. This repair must expose candidate, checked, and failed
  counts; it does not add pagination, recursion, or resumable crawling.

For the HYROX scout, `/de/event/hyrox-basel/schedule/` is eligible.
`/de/finde-dein-race` and `/de/event/another-race/` are not.

### Change and alert semantics

The existing canonicalizer removes known scrape noise and compares normalized
page content with the latest successful capture for the same scout and source
URL. A hash comparison may remain the cheap unchanged gate, but a `changed`
decision produces a bounded before/after content diff.

- `new` during initial scout/index establishment creates a silent baseline.
  A child first linked after an active index baseline is an addition change: its
  first capture is evaluated by both alert modes and becomes its baseline.
- an empty normalized content diff is `same` and does not alert;
- any non-empty normalized content diff is `changed` and makes Any Change
  eligible; and
- Specific Changes evaluates that same diff against the user's criteria with
  enough context to interpret additions, modifications, and removals.

Criteria evaluation returns a structured match decision and the matching changed
passages. It does not need to generate prose. Alerts render deterministic
before/after excerpts, source URLs, and change labels from the diff.

Information-unit extraction and deduplication happen after those decisions:

- zero extracted units cannot veto Any Change;
- merging every extracted unit into an existing inbox item cannot veto a
  qualifying alert; and
- generated summaries are optional enrichment and never an alert prerequisite.

---

## Requirements

**Configuration and baseline**

- R1. A Page Scout retains its two existing modes: Any Change and Specific
  Changes. Specific Changes requires criteria.
- R2. The first successful capture of the configured URL and children present
  during initial index establishment is a silent baseline. A child first linked
  after that baseline is evaluated as an addition change. The bounded child
  candidate set is pinned once in `scouts.metadata` after a successful run,
  including HTML-only candidates, so deferred initial children stay silent
  while later additions do not. Expiring run metadata remains diagnostic only;
  no new membership table is introduced.
- R3. Scheduled execution and Run Now use the same successful baselines and
  alert semantics.

**Index scope**

- R4. Existing automatic index detection remains. One primary-content candidate
  set feeds both index classification and Phase B following. Rendered HTML is
  reduced to main/article content before link extraction. Markdown links remain
  merged to preserve the established anti-bot/shell fallback, including simple
  child routes such as `schedule/`. The strict configured subtree boundary is
  applied before any candidate can be followed, and fetched children still
  have to pass document-shape checks before they create baselines or units.
- R5. `filterSubpageUrls` must enforce same normalized host plus strict
  descendant-path scope. Article-shape heuristics may classify or rank only
  candidates that already pass that boundary; they may not bypass it. The
  provider-reported effective/final URL must pass the same check before content
  is compared, persisted, extracted, archived, or allowed to alert.
- R6. Index following remains single-hop under the existing cap and deadline.
  The active candidate universe is deterministically capped at 500 URLs before
  both membership persistence and rotation, so a deferred URL cannot fall
  outside initial membership and later masquerade as an addition.
  Diagnostics must report candidates, checked children, and failures so a
  partial run is not represented as complete coverage. Work selection must
  rotate fairly across in-scope candidates rather than allowing the same
  zero-unit or fully deduplicated children to monopolize every run.
- R7. Once a URL has been followed as an index child, its latest successful
  capture is its per-source baseline. It is checked on later runs even when the
  configured index content is unchanged. Existing `raw_captures` and
  `hashChangeStatusForUrl(..., { sourceUrl })` are the intended storage and
  comparison and scheduling seams; unit occurrences must not determine whether
  a child is known or due for checking. The newest successful canonical capture
  per source must survive both the 30-day raw-capture TTL and the 90-day run
  cleanup. Initial child membership is pinned once in existing `scouts.metadata`
  during baseline establishment, rather than depending on expiring run
  diagnostics. The current authoritative membership is also stored there so a
  removed child cannot reappear merely because its historical capture remains.
  No new membership table is required.

**Any Change**

- R8. Any Change alert eligibility comes from a non-empty normalized content
  diff
  for the configured URL or a followed child, or from a `new` child first linked
  after an active index baseline. Initial scout/index establishment remains
  silent. Eligibility does not depend on extracted-unit count, unit novelty,
  deduplication, or summary generation.
- R9. Any Change requires no LLM-generated description. Its alert is rendered
  deterministically from the exact changed URL and bounded before/after diff.

**Specific Changes**

- R10. Specific Changes evaluates the bounded before/after diff, not the entire
  current page in isolation. Its evaluator returns `matches` plus the matching
  changed passages; it does not need to return a generated description.
  Unchanged text that matches the criteria cannot turn an unrelated change into
  an alert. Evaluation is capped at eight 20,000-character batches. If an
  unmatched delta exceeds that bound, the run fails without advancing the
  successful baseline; it must never silently record a non-match over content
  the classifier did not inspect.
- R11. A matching criteria result makes the alert eligible before information
  units are deduplicated or inserted. No match produces no alert.

**Failure and attribution**

- R12. Fetch, comparison, diff, criteria-evaluation, or persistence failure cannot
  replace the latest successful baseline or be reported as unchanged. Any
  Change enrichment failure may omit units without
  suppressing the detected alert.
- R13. One run sends at most one aggregated Page Scout notification. It
  identifies the configured root and every qualifying exact source URL.
- R14. Child-derived captures, units, and alert links retain the child's URL;
  the configured index URL remains the scout context.

**Page Archive compatibility**

- R15. Existing archive behavior for the configured root is invariant:
  archive-enabled scout creation and the existing disabled-to-enabled hook each
  produce the one appropriate `baseline` snapshot, while unrelated edits and
  enabled-to-enabled updates do not duplicate it. Those baseline rows retain
  their intentional null run/raw-capture linkage. A successful root
  `new`/`changed` run schedules a run/raw-capture-bound `change` snapshot after
  run finalization and notification; a `same` run produces no change snapshot.
  Snapshot eligibility follows the canonical content-change result, not alert
  eligibility, criteria matching, generated units, or notification delivery.
  Therefore an archive-enabled Specific Changes scout still archives a genuine
  normalized page change when its criteria do not match, even though it sends
  no alert.
- R16. A child-only alert must never present the configured root's snapshot as
  evidence for the child. When archiving is enabled, a child baseline receives
  its own snapshot: children present during initial establishment receive one
  silent `baseline` snapshot; a child first linked after activation is an
  alerting addition and receives one `change` snapshot, not both. Later
  canonical child changes reuse the same archive path with the exact child URL
  and raw-capture relationship whether or not Specific Changes criteria match.
  Because notification currently precedes background capture and its CTA opens
  general scout archive history, an alert involving any child omits the archive
  CTA until an exact-child snapshot target can be resolved; it must not imply
  that an existing root snapshot is evidence for a child. Root-only alerts
  retain the existing CTA.
- R17. Archive capture and trust-layer failures remain non-fatal and honestly
  degraded. The detection scrape remains the baseline/diff input; the separate
  archive fetch must never become change-detection input. The implementation
  must continue to use the existing archive gate, `performArchiveCapture`
  fidelity/degradation behavior, background sequencing, stored-row diagnostics,
  and post-store trust/Wayback layer. Page Scout alert work must not create an
  alternative snapshot writer or make capture/trust latency part of run or
  notification success. Child detection must carry truthful provider provenance
  so the existing capture routing remains valid. A capture re-fetch that
  resolves outside the child's validated scope must not store or submit the
  redirected content; it may only degrade honestly to the already validated
  detection markdown.
- R18. Each changed source in a run receives an independently bound, failure-
  isolated archive context. Its snapshot keeps that source's validated effective
  URL, raw-capture ID, detection hashes, capture kind, and capture-fetch final
  URL. Multiple source outcomes and trust diagnostics must not overwrite one
  another. Every stored child snapshot follows the existing manifest,
  TSA/Wayback, opt-out, and degradation path. Existing scalar root snapshot
  diagnostics remain root-only for compatibility; bounded per-source diagnostics
  record root and child outcomes. Same-run child contexts are deduplicated by
  validated effective source URL before capture.
- R19. Enabling archive for an index with existing child baselines is
  non-retroactive: the first successful post-enable check writes one child
  `baseline` snapshot if that child is unchanged, or one `change` snapshot if it
  changed. It must not synthesize historical evidence or write both kinds.

---

## Acceptance Examples

- AE1. **Any Change with zero units**
  - Given an exact-page baseline;
  - when normalized content changes and extraction returns zero units, or every
    unit merges with an existing inbox item;
  - then one alert is rendered from the before/after diff and exact page URL.

- AE2. **Unchanged content**
  - Given a successful baseline;
  - when normalized content is unchanged;
  - then neither mode alerts and extraction is not used to invent a change.

- AE3. **Specific Changes positive**
  - Given criteria for a registration date;
  - when the before/after diff adds or changes that date;
  - then the evaluator returns a match and the alert renders the matching diff,
    even if the resulting unit is deduplicated and no description is generated.

- AE4. **Specific Changes unrelated negative**
  - Given the baseline already contains a registration date matching the
    criteria;
  - when only an unrelated paragraph changes;
  - then the diff does not match and no alert is sent.

- AE5. **HYROX negative scope regression**
  - Given the configured HYROX Basel URL;
  - when rendered or markdown content includes the four audited sibling
    navigation URLs;
  - then none can classify the page as an index, enter Phase B, create units, or
    produce an alert for that scout.

- AE6. **Positive index child**
  - Given a genuine index rooted at `/news/`;
  - when its primary content links to `/news/item-a/`;
  - then the child receives a silent per-source baseline and a later normalized
    content change at that child is eligible under the selected alert mode.

- AE7. **Unchanged index, changed child**
  - Given a previously followed in-scope child;
  - when the index content is unchanged but that child changes;
  - then the child is still checked and the change is evaluated.

- AE8. **Partial Phase B run**
  - Given more candidates than the current deadline permits;
  - when only some are checked;
  - then diagnostics expose candidate, checked, and failed counts and do not
    claim complete unchanged coverage.

- AE9. **New child after index baseline**
  - Given an active index baseline that does not contain `/news/item-b/`;
  - when the root later links that strict descendant and its first capture
    is successfully fetched;
  - then Any Change alerts on the addition, Specific Changes alerts only when
    that first capture matches its criteria, and neither treats the child as
    initial scout setup.

- AE10. **Archive-enabled root change**
  - Given an archive-enabled scout with a baseline snapshot;
  - when its configured root changes and Any Change extraction produces zero
    units;
  - then the alert is sent and one `change` snapshot is scheduled from the same
    detection event, linked to the run and raw capture.

- AE11. **Archive-enabled child-only change**
  - Given an archive-enabled index whose root is unchanged;
  - when a followed child changes and qualifies for an alert;
  - then the child alert identifies the child and its archive context targets
    that child, never the unchanged root, and the notification omits the generic
    archive CTA rather than pointing at unrelated root evidence.

---

## Implementation Direction

The implementation plan should stay within these existing seams:

1. Restore strict descendant filtering in
   `_shared/subpage-filter.ts`. Remove the off-subtree `isLikelyArticleUrl`
   fallback; retain article heuristics only after scope filtering.
2. Strip HTML navigation chrome before discovery, preserve the repaired
   HTML/markdown merge fallback, and apply the strict configured subtree before
   deterministic listing detection or Phase B following.
3. Extend the existing notification predicate to receive the comparison result
   and alert mode:
   - Any Change: notify on a qualifying `changed` source or a `new` child first
     linked after an active index baseline;
   - Specific Changes: notify on a structured matching-diff result.
4. Decide alert eligibility before unit insertion and canonical-unit dedup.
5. Reuse per-source canonical baselines for followed children, fairly rotate
   candidates within the existing budget, and continue checking known children
   when the root is unchanged.
6. Derive the normalized content diff for every changed source from the prior
   and current successful `raw_captures`; Specific Changes consumes that same
   diff for criteria evaluation. Do not add an event ledger, notification
   outbox, membership table, or persisted scope-mode UI.
7. Render both alert modes deterministically from source metadata and bounded
   diff passages; do not require generated descriptions.
8. Preserve the existing root archive sequencing. Create bounded per-source
   archive contexts immediately after validated comparison and raw-capture
   persistence, before optional extraction. Reuse `performArchiveCapture` and
   the existing trust path for each child with truthful provider provenance,
   exact source URL, raw capture, and detection hashes; isolate per-source
   failures and aggregate diagnostics rather than substituting or overwriting
   root evidence.

---

## Benchmarks, Tests, and Smokes

### Why the existing coverage missed this

- `benchmark-web.ts` asserts positive scrape/unit yield and a positive listing
  case, but has no negative scope assertion for an exact-page scout.
- `benchmark-subpage-follow.ts` previously invoked `scout-web-execute` directly
  and asserted only extracted subpage units. It did not exercise Run Now or
  prove that unrelated same-host pages stayed out.
- `page_scout_notifications_test.ts` encodes the faulty assumption that Any
  Change needs a new unit and summary; it has no changed-with-zero-units case.
- The normal CI workflow does not run the Page Scout notification, scope, or
  subpage contract tests. The deployed Page Scout benchmark runs weekly, after
  a regression can already ship.
- Archive helpers have focused tests, but the Page Scout benchmark does not
  assert the end-to-end relationship between detection, notification, raw
  capture, and evidence snapshot.

### Benchmark governance

Critical benchmark assertions are a product contract:

- Every shipped critical Page Scout behavior has a named deterministic contract
  case that runs in required CI on every pull request, plus a deployed smoke
  where local simulation cannot prove the behavior.
- A feature or fix PR may add cases and strengthen assertions. It may not delete
  or skip an existing contract case, weaken an expected result, lower a
  threshold, substitute an easier fixture, or replace scheduler/delivery
  execution with a direct-function shortcut.
- If a product contract intentionally changes, the benchmark expectation change
  is proposed in a separate, explicitly reviewed PR with the product decision
  and before/after evidence. It is not bundled into the implementation merely
  to make that implementation pass.
- External-fixture maintenance is also separate from feature work. A fixture
  outage may be repaired with equivalent-or-harder coverage, never by removing
  the invariant.
- The Page Scout contract suite is a required pre-merge CI check. The weekly
  live benchmark remains an independent production-health signal, not the first
  place core regressions can be detected.

The deterministic contract tests run in the repository's normal required Edge
Function CI, so implementation-only changes cannot bypass them through workflow
path filters. Benchmark expectation or fixture changes are reviewed as product
changes and kept separate from the implementation they evaluate; bespoke
byte-for-byte test freezing is intentionally avoided because it would make
legitimate canary maintenance harder without proving worker behavior.

**Deterministic tests**

- Notification predicate:
  - Any Change + non-empty normalized diff + zero units/description => alert;
  - Any Change + `same` => no alert;
  - Specific Changes + matching diff + no generated description + all units
    deduplicated => alert;
  - Specific Changes + unrelated diff => no alert.
- Scope filter:
  - strict descendant positives;
  - parent, sibling, subdomain, and segment-prefix negatives;
  - the four exact HYROX sibling URLs as negatives;
  - in-scope requests whose effective URL redirects outside the subtree;
  - rendered and markdown-only provider responses preserve simple strict
    descendants such as `/schedule/`;
  - fetched non-document descendants cannot create baselines or units;
  - root-index descendants remain supported.
- Per-source baselines:
  - first child capture is silent;
  - unchanged child is silent;
  - changed child is detected when the index is unchanged;
  - fair rotation eventually checks every candidate beyond one run's cap,
    including children that produce zero or deduplicated units;
  - a child added after activation is evaluated on first capture;
  - failed runs do not advance the successful baseline;
  - the newest successful baseline for every root/child source survives raw
    capture TTL cleanup and run deletion;
  - initial child membership is first-write-wins on the scout and survives run
    cleanup.
- Specific Changes:
  - addition, modification, and removal in the diff can match;
  - static matching text outside the diff cannot match.
- Page Archive:
  - archive-enabled baseline produces a `baseline` snapshot;
  - archive creation/enable hooks preserve their existing null run/raw-capture
    linkage and do not duplicate baselines on unrelated or enabled-to-enabled
    updates;
  - root `changed` with zero units still alerts and schedules one `change`
    snapshot with the same run/raw-capture provenance;
  - root `changed` on a Specific Changes scout whose criteria do not match sends
    no alert but still schedules one `change` snapshot;
  - `same` schedules no change snapshot;
  - an initial archive-enabled child receives one child `baseline` snapshot;
    a child first linked after activation receives one child `change` snapshot;
    a later canonical child change schedules child `change` evidence even when
    Specific Changes criteria do not match; and a later child-only alert never
    labels root evidence as the changed child's archive;
  - every snapshot preserves the existing archive gate, capture fidelity,
    content-hash binding, honest `markdown_only` degradation,
    background/non-fatal sequencing, and trust/Wayback behavior; change
    snapshots additionally preserve run/raw-capture provenance;
  - a child archive re-fetch redirected outside validated scope stores no
    redirected artifacts and triggers no trust/Wayback submission for that
    target, while honest degradation may preserve validated detection markdown;
  - Firecrawl- and crawl4ai-served child detections retain truthful provider
    provenance and take the existing corresponding capture path;
  - multiple changed children produce independently URL-bound snapshot rows and
    diagnostics without overwriting or misattributing another child's result;
  - a changed root plus two changed children produces three independently bound
    contexts; legacy scalar diagnostics still describe only the root while
    per-source diagnostics retain all outcomes;
  - two discovered aliases resolving to the same validated effective child URL
    produce only one same-run child archive context;
  - after archive is enabled for a previously monitored index, an unchanged
    known child gets one non-retroactive `baseline`, while a changed known child
    gets one `change`, never both;
  - one source's capture or trust failure does not suppress sibling captures,
    the alert, notification status, or run success;
  - root-only notifications retain their existing archive CTA behavior; alerts
    involving a child omit the generic CTA until exact child targets exist,
    including mixed root/child alerts and total capture failure.

**Page Scout benchmark**

Extend the existing Page Scout and subpage-follow benchmark runners rather than
creating a separate monitoring framework. The required matrix is:

1. exact-page Any Change with a real normalized change and zero inserted units;
2. exact-page Specific Changes with a matching diff;
3. exact-page Specific Changes with static matching text and an unrelated diff;
4. positive strict-descendant index child change while the index is unchanged,
   exercised in Any Change and in matching Specific Changes;
5. unchanged-index child change that is unrelated to Specific Changes criteria
   and remains silent;
6. a child first linked after activation: Any Change alerts on its first capture,
   while matching and non-matching Specific Changes behave accordingly;
7. fair rotation across more candidates than one run can process, including
   zero-unit children;
8. negative HYROX sibling/navigation fixture with zero forbidden sibling
   captures/units and zero notification; eligible strict descendants such as
   `/de/event/hyrox-basel/schedule/` do not fail this canary.

The Page Archive compatibility canary runs alongside this matrix and verifies
the baseline/change/same and exact-child provenance cases above.

**Smokes**

- Run the deterministic Page Scout contract through the existing local/OSS
  smoke runner.
- Run controlled Any Change and index-child fixtures through Run Now on the
  deployed SaaS path. The index-child fixture uses Specific Changes and verifies
  exact source URL, archive provenance when enabled, and notification status.
- Run at least the Any Change zero-unit case through the actual production
  scheduler, not a direct function substitute, and verify the notification is
  sent.

---

## Release and Remediation

The repair is ready when:

- all deterministic cases, the eight-case Page Scout matrix, and the Page
  Archive compatibility canary pass;
- Run Now and scheduler smokes pass without out-of-subtree captures or units;
- existing Page Scouts keep their configured URL and current root baseline;
- rollout does not silently reclassify existing baseline content as a change;
  and
- the HYROX Basel scout produces no forbidden sibling captures, units, or
  alerts.

After deployment verification, remove the 23 invalid HYROX units with a
targeted, auditable operation. Data cleanup is not part of the code fix and
must not occur before the corrected scope is live.

---

## Non-goals

- new Automatic / Exact Page / Index user settings;
- recursive, paginated, site-wide, or resumable crawling;
- a new index-membership table or lifecycle;
- a notification outbox or cross-run event ledger;
- a new disappearance policy or run-state taxonomy;
- a billing, authentication, URL-security, or cross-surface redesign; and
- changing existing safety, ownership, delivery, or credit behavior except
  where the two alert contracts require it.

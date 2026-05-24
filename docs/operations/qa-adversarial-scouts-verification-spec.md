# QA verification spec — adversarial scouts kicked off 2026-05-24

**Open this file when you want to verify the QA scouts.** Earliest sensible
date: 2026-05-27 (≥72h after kickoff). The 5 daily-scheduled scouts will have
fired ~3 times by then; the 3 weekly-scheduled scouts will only have the
initial run plus whatever `pg_cron` triggered.

The companion file
[`qa-adversarial-scouts-2026-05-24.md`](./qa-adversarial-scouts-2026-05-24.md)
has the full bug-prediction table and scout/run IDs.

---

## Pre-flight (10 min)

```bash
# Confirm the CLI is current and authed
scout user me                                 # should show your account, credits

# List the QA scouts
scout scouts list | grep '^[0-9a-f].*qa-'     # expect 8 rows, all is_active=true
```

If you see `consecutive_failures > 2` on any scout, **read its scout state and
recent runs first** — that scout is the bug. The other 7 are normal.

---

## Per-scout verification loop

For each of the 8 scout IDs below, do the 5-step pass:

| # | Scout | ID | Source URL to re-scrape |
|---|---|---|---|
| 1 | qa-web-hn-reorder | `3eeb087d-54cb-496d-9ed2-5cdde75df5ea` | `https://news.ycombinator.com/` |
| 2 | qa-web-guardian-consent | `0aa6c28a-607a-4ab8-9e7a-8fb75adf9087` | `https://www.theguardian.com/world` |
| 3 | qa-web-bloomberg-paywall | `ebdf3c89-8d7e-45bf-ad97-726e015da685` | `https://www.bloomberg.com/markets` |
| 4 | qa-beat-muestair-tiny | `8d80c589-ba7c-4d0e-a55d-209d5aa71eb7` | (sample 3 unit source_urls) |
| 5 | qa-beat-zurich-german-policy | `41dea221-6048-4afb-ae57-2d4500c54404` | (sample 3 unit source_urls) |
| 6 | qa-social-x-highvol-nytimes | `5ff4cf36-1b29-4c29-b636-ccb47dcb246f` | `https://x.com/nytimes` |
| 7 | qa-social-tiktok-thetimes | `255bfdba-d848-4e81-80cf-feaf654546e1` | `https://www.tiktok.com/@thetimes` |
| 8 | qa-civic-stadt-zurich | `dde53311-3512-4ce5-9107-0fb6d6d620f7` | `https://www.stadt-zuerich.ch/de/politik-und-verwaltung/stadtrat/sitzungen-und-geschaeftsverzeichnis.html` |

### The 5 steps

```bash
ID=<scout id>

# 1. Scout state — last_run_at, consecutive_failures, metadata.retrieval
scout scouts show $ID

# 2. Recent runs — how many fired in 72h, how many notified, errors?
# (no CLI subcommand yet for runs; use curl)
curl -sS \
  -H "Authorization: Bearer $(jq -r .api_key ~/.scoutpost/config.json)" \
  -H "apikey: $(jq -r .supabase_anon_key ~/.scoutpost/config.json)" \
  "https://scoutpost.ai/functions/v1/runs?scout_id=$ID&limit=20" | jq .

# 3. Recent units — what did the pipeline extract?
scout units list --scout $ID | head -50

# 4. Pick 3 units (or 3 source URLs for beat). Fresh-scrape each + diff.
firecrawl scrape <source_url>                 # cached in .firecrawl/
# Compare extracted summary vs current markdown. Look for hallucinations,
# missed key facts, paywall artifacts, language mismatches.

# 5. For web scouts only — fresh-scrape the scout's own URL and compare
# the canonical content against the most recent run's units.
firecrawl scrape <scout url>
```

---

## What to look for — per-scout expected bugs

Listed in priority order of "this would be a real bug worth filing."

### 1. qa-web-hn-reorder (priority: HIGH)
HN reorders constantly. Canonical hash should track content not order.
- **Failure mode:** notifications fired > 1 across 3 daily runs → hash is order-sensitive.
- **Likely fix location:** `supabase/functions/_shared/web_content_canonical.ts`.
- **Acceptable:** 0–1 notifications.

### 2. qa-beat-muestair-tiny (priority: HIGH — tests the runtime fallback)
Müstair has ~750 people. Exa won't find much.
- **Failure mode A:** scout `metadata.retrieval` flipped to `firecrawl` after 3 consecutive low-coverage Exa runs → 3-strikes auto-pin works (this PR notes that's now a deletion candidate; if it fires, document the call).
- **Failure mode B:** metadata is still `exa` or unset AND Exa returns <2 hits every time → auto-flip logic is broken.
- **Failure mode C:** Exa returns generic Swiss news mis-tagged as Müstair → locality filter is too loose.

### 3. qa-beat-zurich-german-policy (priority: MEDIUM)
German-language criteria against an English-anchored LLM pipeline.
- **Failure mode:** unit summaries are English machine translations of German source headlines, losing nuance.
- **Acceptable:** German source quoted in original + English-language summary that preserves German terms in quotes.

### 4. qa-social-x-highvol-nytimes (priority: MEDIUM)
~50 posts/day. Tests Apify pagination + diff cutoff.
- **Failure mode:** units_created from runs vs Apify dataset size has a > 20% gap → filter too aggressive or dedup bucketing distinct posts.

### 5. qa-social-tiktok-thetimes (priority: MEDIUM)
TikTok pipeline is the rate-limit-prone path.
- **Failure mode:** any item in `removed_unit_ids` that is still live on tiktok.com/@thetimes → stale-baseline bug (Civic was fixed in PR #190; Social TikTok wasn't in scope).

### 6. qa-civic-stadt-zurich (priority: MEDIUM)
German civic agendas + PDFs.
- **Failure mode:** > 30% of extracted "promises" are not actually policy commitments (e.g. procedural language like "Bewilligung wird erteilt" misclassified).

### 7. qa-web-bloomberg-paywall (priority: LOW — explicitly testing failure mode)
Paywall blocks Firecrawl from reading article body.
- **Failure mode:** criteria analysis returns matches on teaser/marketing shell → false positives.
- **Acceptable:** zero criteria matches, or matches only on substantive content.

### 8. qa-web-guardian-consent (priority: LOW)
Consent banner + recirculation modules + region routing.
- **Failure mode:** captured markdown is mostly nav/cookie/ads → canonical hash is hashing noise. Measure capture length vs visible article length on the fresh scrape.

---

## Also worth re-checking

- **Beat scout creation 502 → `[object Object]`** (observed 2026-05-24). This PR
  fixes both halves (CLI error unwrap + background baseline). Verify by
  creating + deleting a throwaway beat scout:
  ```bash
  scout scouts add --name "qa-cli-recheck" --type beat \
    --description "verify post-deploy" --criteria "x" --topic "qa-recheck" \
    --location-json '{"label":"Zürich, Switzerland","city":"Zürich","country":"Switzerland","latitude":47.3769,"longitude":8.5417}' \
    --source-mode reliable --regularity weekly --day 4 --time 22:30
  # Then immediately:
  scout scouts list | grep qa-cli-recheck
  scout scouts delete <id>
  ```
  Expected after deploy: 201 response, no 502. If still 502 → Edge Function didn't redeploy, or the platform timeout is hitting something else.

- **Exa default flip soak.** Run this once you've done the 8-scout pass:
  ```bash
  # via SQL (Supabase studio or MCP):
  select retrieval, count(*), max(created_at) as last_seen
  from beat_ab_runs
  where created_at > now() - interval '72 hours'
  group by retrieval;
  ```
  Should be majority `exa`. If `firecrawl` dominates, the env kill switch may
  have been set, or scouts have per-scout `metadata.retrieval=firecrawl`
  pinned from before the flip.

---

## Output

Create `docs/operations/qa-adversarial-scouts-results-2026-05-2X.md` (use the
actual verification date in the filename). One section per scout:

```markdown
## qa-web-hn-reorder

**Outcome:** PASS | BUG | INCONCLUSIVE

**Evidence:**
- runs in 72h: 3
- notifications fired: 0
- canonical hash stable across 3 reorders: yes

**Recommendation:** keep monitoring | file Linear bug "..." | pause scout
```

End the doc with:
- A summary table (8 rows, columns: scout / outcome / one-line note).
- A list of Linear issues to file (title + labels: `Bug` + `coJournalist`).

Then either open a follow-up PR with the doc, or commit it directly to a fresh
branch — your call based on whether there are bugs to file alongside.

---

## Cleanup after verification

The 8 QA scouts will keep consuming credits on their schedules. After you've
written the results doc, decide per-scout:

- **PASS** → pause or delete. They've served their purpose.
- **BUG filed** → keep active so the next run becomes a regression test for the fix.
- **INCONCLUSIVE** → keep active, re-verify in another week.

```bash
scout scouts pause <id>       # stops scheduled runs, keeps history
scout scouts delete <id>      # full removal
```

# Crawl4AI 0.9.2 release validation

Date: 2026-08-10  
Bookmark: `agent/crawl4ai-0.9.2` (stacked on `agent/crawler-simplification`)  
Status: local gates passed; Render deployment, production canary, and bake pending

This record covers the independent U4 dependency update from Crawl4AI 0.8.9
to 0.9.2. It does not authorize deploying U4 before the U1–U3 semantic
cleanup has completed its own production bake.

## Build identity

The candidate was built with `docker build --pull --no-cache` from
`python:3.12-slim-bookworm@sha256:4766d8b510c428e595d74b9cc5bbb2fae8e26316fffb4adc89908d79aacd58a2`.
The clean build downloaded Chrome for Testing 149.0.7827.55, Playwright
Chromium revision 1228, and did not reuse the 0.8.9 browser layer.

| Artifact | Local immutable image ID | Architecture | Size |
| --- | --- | --- | ---: |
| 0.9.2 candidate | `sha256:c2898b5a68a6ac000d40229adde8303d4428d9af9694f8d0548b7c54ab6dadfb` | arm64 | 777,722,503 bytes |
| 0.8.9 pin-only control | `sha256:006f46cbe4200daaec64f1a5e42115a7557da78647b1d734d0ad4002eef12a97` | arm64 | 777,562,306 bytes |

The control was built from the same application tree and browser installer,
with only `crawl4ai==0.9.2` reverted to `crawl4ai==0.8.9`. This prevents the
new guarded egress proxy or other U1–U3 changes from being misattributed to
the dependency update. The 0.8.9 image must be retained until the production
bake passes.

Resolved version-sensitive packages in the candidate are:

- Crawl4AI 0.9.2
- Patchright 1.61.2
- Playwright 1.62.0
- Render SDK 0.7.0

The complete image resolution is preserved in
[`scrape-service/crawl4ai-0.9.2.freeze.txt`](../../scrape-service/crawl4ai-0.9.2.freeze.txt).
It is evidence for this image, not a second installation input.

The local IDs are not the production digest: the Render amd64 build digest
must be added here after deployment, together with the deployed source
revision.

## Installed-source inspection

The installed 0.9.2 source was inspected before the pin was changed:

- `AsyncWebCrawler`, `BrowserConfig`, `CrawlerRunConfig`, and `CacheMode`
  retain the APIs used by Scoutpost.
- `AsyncPlaywrightCrawlerStrategy` still accepts `UndetectedAdapter`, whose
  implementation uses Patchright's isolated evaluation path.
- `BrowserConfig.proxy` is deprecated in 0.9.2. Scoutpost now uses the
  supported `proxy_config={"server": ...}` form, with a focused constructor
  test to prevent a silent proxy bypass.
- The render lifecycle scans the page, executes post-wait `js_code`, captures
  `page.content()`, and only then captures MHTML and the screenshot. This keeps
  disclosure expansion observable in all same-render artifacts.
- MHTML still uses CDP `Page.captureSnapshot` with `format: "mhtml"` and
  detaches its session after capture.
- Full-page screenshot selection still honors `scan_full_page`; long pages
  use the bounded scrolling compositor and short pages use the native path.
- Upstream result shapes remain contained by `app/mapping.py`; no Crawl4AI
  object crosses into Edge Functions.

## Automated and live-browser gates

| Gate | Result |
| --- | --- |
| Scrape-service unit suite | 159 passed, 6 live deselected |
| Unit coverage | 100.00% over 704 statements |
| Ruff | Passed |
| Release-image live-render module | 6 passed in 12.20 seconds |
| Deno corpus/config/contract/gate modules | 11 passed; formatter and type-check passed |

The live module ran in a thin pytest layer whose base was the exact candidate
image ID above. It covered a real rendered page, same-render MHTML and PNG,
native-details and TikTok-style disclosure expansion, final-origin gating,
full-page behavior, and crawler cleanup. A previously global unit-test DNS
stub was found to rewrite every live hostname to the example.com fixture IP;
the fixture now preserves real DNS for `live`-marked tests.

The exact candidate image was also exercised as its production FastAPI
process on a loopback-only port:

- health returned 200 and changed from cold to warm;
- authenticated `https://example.com` returned markdown, raw HTML, metadata,
  source URL, and status 200;
- missing authentication returned 401;
- loopback and `169.254.169.254` targets returned 422;
- public upstream socket failures were contained as controlled 502 responses;
- logs contained neither the deprecated proxy warning nor unhandled proxy
  callback exceptions.

The same process captured `https://en.wikipedia.org/wiki/Web_archiving` in a
single render: 76,464 markdown characters, 487,040 raw-HTML characters,
951,312 MHTML bytes, and a 3,576,445-byte PNG. The MHTML SHA-256 was
`f24f3cad98eff61a292497b29c174f5fb6704b92638f3070ac84cfb7a246e9bd`;
the PNG SHA-256 was
`3e7243712febdecb647a0ef78458f07ab8652f370a9dd87b65f88774ccf5ea38`.
The MHTML was `multipart/related`, the PNG magic was valid, and response
headers were present.

## Public-corpus shadow

`record-scrape-baseline.ts` first recorded all eight maintained civic and
registry cases against both versions. Each version scored 6/6 on every case
and matched or improved every frozen Firecrawl score.

The final pin-only comparison used `shadow-crawl4ai-versions.ts`. It ran five
repetitions, or 40 measured public scrapes per image. Each repetition started
fresh control and candidate browser processes, warmed both on the same
non-corpus page, and ran the same rotated page order concurrently. The harness
verifies each container's immutable image ID before it may restart the
container. It records exact cgroup peaks for every equal-load repetition and
fails on any incomplete probe score, response-contract field regression,
unexplained dominant canonical hash, p95 or paired-case latency regression,
paired peak-memory regression, or 2 GiB breach.

The complete machine-readable result is preserved in
[`crawl4ai-0.9.2-shadow-2026-08-10.json`](../../scripts/benchmarks/baselines/crawl4ai-0.9.2-shadow-2026-08-10.json).

| Metric | 0.8.9 control | 0.9.2 candidate | Gate |
| --- | ---: | ---: | --- |
| Complete outputs | 40/40 | 40/40 | Passed |
| Probe-score regressions | — | 0 | Passed |
| Contract mismatches | — | 0 | Passed |
| p95 latency (nearest-rank, n=40) | 3,109 ms | 3,094 ms | −0.5%; passed (maximum +10%) |
| Median paired per-case ratio | 1.000 | 0.997 | −0.3%; passed (maximum +10%) |
| Maximum exact cgroup peak memory | 575,549,440 bytes | 571,428,864 bytes | −0.7%; under 2 GiB |
| Median paired repetition-peak ratio | 1.000 | 0.993 | −0.7%; passed (maximum +5%) |
| OOM | No | No | Passed |
| Pairwise canonical differences | — | 3/40 | Dominant hashes equal; passed with no allowlist |

Seven cases were pairwise canonically identical in all five repetitions.
Companies House differed three times: each image returned the same 20 records
and byte count but the live search occasionally reordered two dissolved-company
entries. Both versions had the same dominant canonical hash, and the required
identifiers and address/incorporation probes remained present. No
canonical-drift allowlist was used.

The maintained Lausanne fixture was replaced before the final run. Repeated
release checks caused its WAF to return a 167-character status-334 support-ID
page; which image was rejected depended on request timing, including after
fresh browser starts. The new Vaud Grand Council sessions fixture returned
identical 93,782-character output across six exploratory renders and all ten
measured control/candidate renders. Its Firecrawl `onlyMainContent` reference
was re-recorded on 2026-08-10 (6/6 probes), and that raw reference is preserved
with its manifest. The two Crawl4AI output hashes, lengths, scores, and contract
comparisons are preserved in the shadow report. The benchmark's strict probe
gate would reject either the former WAF page or any future dead/error fixture.

The per-repetition cgroup peaks were 575,471,616, 575,549,440, 552,972,288,
551,071,744, and 540,078,080 bytes for 0.8.9; and 543,821,824, 571,428,864,
559,742,976, 543,842,304, and 548,851,712 bytes for 0.9.2. This is measured by
the release harness itself rather than a separate manual observation.

No shadow result is allowed to overwrite a production baseline. Production
canonical differences must still be reviewed before any explicit rebaseline.

## Gates that require Render or elapsed production time

The following are intentionally not claimed by this local record:

- U1–U3 must deploy first and complete seven stable production days,
  including a Monday peak, without changing Workflow routing percentages.
- Build and record the final Render amd64 0.9.2 image digest and deployed
  source revision.
- Exercise authenticated HTTP `/scrape` and the deployed `crawl_batch`
  Workflow task on that exact revision, including callback, artifact, guarded
  egress, cleanup, and memory evidence.
- Shadow a bounded production cohort against the retained 0.8.9 image with
  notifications and automatic rebaselining disabled.
- Confirm no unexplained increase in anti-bot fallback, terminal errors,
  canonical drift, alert decisions, or OOMs.
- Complete seven stable 0.9.2 production days including one normal peak
  period before releasing the 0.8.9 rollback image.

Rollback remains an image-only operation: restore the retained 0.8.9 image
and its matching browser layer. No database rollback or baseline mutation is
part of the pin change.

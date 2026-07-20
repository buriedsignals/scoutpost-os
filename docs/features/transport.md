# Fleet Scout (type `transport`)

AI-adjacent physical-movement monitoring: **vessels** (AIS), **aircraft**
(ADS-B), and **satellites** (orbital elements). A transport scout alerts
**once** when a **tracked object enters a watched area**, using the same pg_cron → `execute-scout` → worker pipeline as every
other scout type. Pro-gated on SaaS; ships in the OSS mirror.

**Every scout must list the specific objects it tracks** — `watch_ids` (up to
20 MMSIs / ICAO hexes / NORAD ids per scout) is mandatory for all modes.
Area-only or category-only scouts ("all military ships crossing a point") are
rejected at create/run time: that's a firehose, not monitoring (product
decision 2026-07-04). `categories` only narrow a watch list further.

## Modes

| Mode | Data source | Scope | Alert |
|------|-------------|-------|-------|
| `aircraft` | adsb.lol (`/v2/point`, `/v2/mil`, `/v2/hex`) | watch IDs (ICAO hex) and a circular area required | a watched aircraft enters the area |
| `vessel` | VesselAPI exact-MMSI REST sampler → `transport_positions` | watch IDs (MMSIs) and a circular area required | a watched vessel enters the area |
| `satellite` | CelesTrak GP (OMM/JSON) → SGP4 | watch IDs (NORAD ids) and a circular area required | predicted overflight of the area |

The area is selected with the MapTiler geocoder and stored as a circle (center,
radius, optional display name and MapTiler ID). Fleet Scout has no presets. Free-text
`criteria` are optional: they filter alerts after an object enters the area and do not
replace the area. On hosted Scoutpost, creating or replacing Fleet Scout configuration
requires a Pro or Team account; OSS deployments remain ungated.

Where users find IDs (linked below the watch-IDs field in the UI):
vessels → [MarineTraffic](https://www.marinetraffic.com/), aircraft →
[ADS-B Exchange](https://globe.adsbexchange.com/), satellites →
[CelesTrak SATCAT](https://celestrak.org/satcat/search.php).

## Scheduling & credits

- Cadence: `3h` / `6h` / `12h` / `daily` (default `3h`; satellites daily
  only). No sub-3h cadences.
- Cost: **1 credit per run**, **+1** when free-text criteria are configured
  (an LLM pass over the entrants). Monthly multipliers: 3h ×240, 6h ×120,
  12h ×60, daily ×30.

## Enter-only alerting

Presence is judged by position age, not run counting, so an anchored vessel
or loitering aircraft does not re-alert. Each object is claimed transactionally
so concurrent runs cannot double-email. Time-based eviction re-arms a genuine
re-entry. The first run of a scout establishes a **silent baseline** (records
what is already inside, alerts nothing) for legacy/API creation that does not
provide a tested baseline. In the UI, Step 1 checks the live IDs and prepares
that silent baseline before Step 2 names and schedules the scout, so the first
scheduled run can report genuine entries that happened after the test. Vessel
tests request a current position for every watched MMSI before deciding which
are inside the requested area, and satellite tests
refresh an empty or stale orbit cache, so the first Fleet Scout can complete
Step 1 on a clean deployment.

The same two-step contract is public on every client surface:

- REST: `POST /transport-test`, then `POST /scouts` with the returned
  `baseline_ids` in `transport_baseline_ids`.
- MCP: `test_transport_config`, then `create_scout` with
  `transport_baseline_ids`.
- CLI: `scout scouts test-transport ...`, then `scout scouts add ...
  --baseline-ids <comma-separated-ids>`. Use `--baseline-ids ''` for a tested
  empty baseline.

Omitting `transport_baseline_ids` retains the legacy silent-first-run behavior.

**Shared-infrastructure staleness never auto-deactivates a scout.** If the vessel
sampler or the satellite GP refresh is judged stale, runs record a visible
`skipped` status and the scout resumes automatically when the source recovers.
Vessel liveness requires a successful shared sampler heartbeat within 90
minutes, independent of the consumer scout's cadence, and cached positions older
than 125 minutes are excluded. A failed sampler can no longer be masked for up
to two days by a daily scout's old position cache.

## Categories & watchlists

Aircraft category filters (`military`, `government`, `police`, `civil`) resolve
against a bundled watchlist imported from **plane-alert-db**; `military` also
honors adsb.lol's `dbFlags` military bit as a fallback. Vessels classify by AIS
type code (tanker/cargo/passenger/…) and flag state (MMSI MID).

Refresh the watchlist with
`scripts/ops/refresh-transport-watchlists.ts` (service-role). It **refuses to
import** unless the upstream still declares the ODbL/DbCL license.

## Data attribution & licensing

| Source | Used for | License / terms |
|--------|----------|-----------------|
| [adsb.lol](https://adsb.lol) | aircraft positions | ODbL — attribution required; contact operator before high-volume production use |
| [VesselAPI](https://vesselapi.com) | primary exact-MMSI vessel positions | paid Basic plan; operator is separately confirming derived-alert rights |
| [CelesTrak](https://celestrak.org) | satellite orbital elements | public domain; one-download-per-update fair use (daily fetch complies) |
| [plane-alert-db](https://github.com/sdr-enthusiasts/plane-alert-db) | aircraft watchlist categories | **ODbL 1.0 / DbCL 1.0** |

**ODbL share-alike (plane-alert-db):** the derived `transport_watchlists`
rows are a derivative database of plane-alert-db and are therefore offered
under the **Open Database License 1.0**, preserving attribution to
`sdr-enthusiasts/plane-alert-db`.

VesselAPI is the sole vessel-position provider. The adapter sends one bounded
50-row bulk request, retains only requested
MMSIs, drops provider-glitched/invalid positions, and coalesces the newest row
per identity. Partial coverage is healthy ingestion: available positions are
written and the heartbeat records only a sanitized missing-ID count.

- VesselAPI is the active technical choice. Public-sample and authorized active-
  fleet audits passed: four of five production MMSIs returned valid positions
  3-20 minutes old; the fifth returned a clean 404. Each request consumes one of
  the Basic plan's 1,500 monthly calls. The operator authorized production use
  and is separately seeking written confirmation for derived end-user alerts.
- Poseidon AIS explicitly markets journalism/OSINT and defense use, but requires
  complete terms, price/credit confirmation, and a trial coverage check.
- Datalastic's public terms permit non-raw commercial end-user products, but
  expressly prohibit military/defense use; it can only route eligible civilian
  scouts without a different written agreement.
- MyShipTracking and Data Docked are not production candidates under their
  public internal-use licenses. The former recommendation of MyShipTracking as
  the default paid swap is withdrawn.
- Fintraffic/Digitraffic and BarentsWatch are useful licensed regional routes,
  not global fallbacks.

VesselAPI Basic samples at minute 7 hourly: about 720 bulk calls/month leaves
room for live configuration tests and canaries,
whereas 30-minute sampling consumes about 1,440 of 1,500 calls. Hourly sampling
still precedes the minimum three-hour vessel-scout cadence.

The cron authenticates with the dedicated `internal_service_key` Vault secret,
not the rotatable service-role bearer. Operators can request an immediate
service-role-only canary with `trigger_transport_sampler('ais')`; the RPC
returns only the pg_net request ID, while the result is recorded in
`transport_sampler_runs`.

**Excluded on purpose:** OpenSky (non-commercial), Global Fishing Watch
(non-commercial API), and the shadowbroker yacht / PLAN-CCG vessel lists
(unlicensed, partly synthetic).

## Honest limitations

- Cadence promises **presence detection** (patrols, loitering, anchored
  fleets, watched IDs), not transit interception — a fast crossing between
  checks can be missed.
- Terrestrial AIS has mid-ocean gaps; chokepoint/coastal geofences (the
  intended use) have strong coverage.
- VesselAPI terrestrial coverage may omit a valid but non-reporting MMSI. When
  VesselAPI has no recent successful heartbeat, vessel runs are treated as data-unavailable,
  remain active, skip unbilled, and preserve entry/exit state for recovery.
- Satellite passes are **predictions** from orbital elements, labelled as
  such in alerts.

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
| `vessel` | aisstream.io (shared sampler → `transport_positions`) | watch IDs (MMSIs) and a circular area required | a watched vessel enters the area |
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
what is already inside, alerts nothing) — alerts begin on the second run.

**Shared-infrastructure staleness never auto-deactivates a scout.** If the AIS
sampler or the satellite GP refresh is behind, runs record a visible `skipped`
status and the scout resumes automatically when the source recovers — a
sampler/GP outage cannot cascade the fleet into deactivation.

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
| [aisstream.io](https://aisstream.io) | vessel AIS positions | free beta, no SLA; commercial terms unresolved (see below) |
| [CelesTrak](https://celestrak.org) | satellite orbital elements | public domain; one-download-per-update fair use (daily fetch complies) |
| [plane-alert-db](https://github.com/sdr-enthusiasts/plane-alert-db) | aircraft watchlist categories | **ODbL 1.0 / DbCL 1.0** |

**ODbL share-alike (plane-alert-db):** the derived `transport_watchlists`
rows are a derivative database of plane-alert-db and are therefore offered
under the **Open Database License 1.0**, preserving attribution to
`sdr-enthusiasts/plane-alert-db`.

**aisstream.io commercial status:** aisstream provides no ToS document and its
maintainers have not responded to commercial-licensing queries. The vessel
adapter is isolated behind `vessel.ts` so it can be swapped for a paid REST
provider (MyShipTracking credit packs, else Datalastic) without touching the
rest of the pipeline. Decision deadline tracked separately.

**Excluded on purpose:** OpenSky (non-commercial), Global Fishing Watch
(non-commercial API), and the shadowbroker yacht / PLAN-CCG vessel lists
(unlicensed, partly synthetic).

## Honest limitations

- Cadence promises **presence detection** (patrols, loitering, anchored
  fleets, watched IDs), not transit interception — a fast crossing between
  checks can be missed.
- Terrestrial AIS has mid-ocean gaps; chokepoint/coastal geofences (the
  intended use) have strong coverage.
- Satellite passes are **predictions** from orbital elements, labelled as
  such in alerts.

/**
 * scout-transport-execute Edge Function — transport scout worker.
 *
 * Called internally by execute-scout for scouts of type `transport`. Flow:
 *   1. Load scout (incl. config JSONB).
 *   2. Overlap guard: a fresh `running` row for this scout skips the run so
 *      concurrent dispatches (cron + Run Now) cannot double-alert.
 *   3. Create (or reuse) a scout_runs row, status='running', 30-day TTL.
 *   4. Non-billable pre-checks: config parse/validation.
 *   5. Charge credits, then execute the mode pipeline.
 *   6. On any throw after charging: refund + markRunError + failure counter.
 *
 * U1 scaffolding: no mode executor is implemented yet (aircraft lands in U2,
 * vessel in U3, satellite in U4), so step 5 completes the run as an unbilled
 * `skipped` with an explanatory message. The lifecycle around it — dispatch,
 * overlap guard, validation, charge/refund seams — is real and tested.
 *
 * Auth: shared service auth (X-Service-Key / service-role bearer).
 */

import { z } from "https://esm.sh/zod@3";
import { handleCors } from "../_shared/cors.ts";
import { requireServiceKey } from "../_shared/auth.ts";
import { getServiceClient } from "../_shared/supabase.ts";
import { jsonError, jsonFromError, jsonOk } from "../_shared/responses.ts";
import {
  AuthError,
  NotFoundError,
  ValidationError,
} from "../_shared/errors.ts";
import { logEvent } from "../_shared/log.ts";
import {
  classifyRunError,
  markNotificationAttempted,
  markNotificationResult,
  markRunError,
  markRunStage,
  markRunSuccess,
  shouldIncrementScoutFailure,
} from "../_shared/run_lifecycle.ts";
import {
  CREDIT_COSTS,
  decrementOrThrow,
  getTransportCost,
  InsufficientCreditsError,
  insufficientCreditsResponse,
  refundCredits,
} from "../_shared/credits.ts";
import { incrementAndMaybeNotify } from "../_shared/scout_failures.ts";
import { sendTransportScoutAlert } from "../_shared/notifications.ts";
import {
  IMPLEMENTED_MODES,
  overlapCutoffIso,
  precheckTransportScout,
  shouldYieldToPeer,
  transportRunExpiresAt,
} from "./lib.ts";
import { resolveGeofence } from "./geofence.ts";
import {
  fetchAircraftCandidates,
  fetchWatchlistHexes,
  filterAircraft,
  watchlistPopulated,
} from "./aircraft.ts";
import { applyCriteria } from "./criteria.ts";
import { syncStateAndClaimEntrants, unclaimEntrants } from "./state.ts";
import {
  type AlertScope,
  composeAircraftStatement,
  composeSatelliteStatement,
  composeVesselStatement,
  type EntrantEvent,
  MODE_SOURCE,
  UnitWriteError,
  writeEntrantUnits,
} from "./events.ts";
import {
  fetchVesselsInGeofence,
  filterVessels,
  isSamplerFresh,
  type VesselObject,
} from "./vessel.ts";
import {
  fetchWatchedElements,
  type GpElement,
  isGpCacheFresh,
  passStateKey,
  predictPasses,
} from "./satellite.ts";

const InputSchema = z.object({
  scout_id: z.string().uuid(),
  run_id: z.string().uuid().optional(),
  user_id: z.string().uuid().optional(),
});

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== "POST") {
    return jsonError("method not allowed", 405);
  }

  try {
    requireServiceKey(req);
  } catch (e) {
    return jsonFromError(e instanceof AuthError ? e : new AuthError());
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonFromError(new ValidationError("invalid JSON body"));
  }
  const parsed = InputSchema.safeParse(body);
  if (!parsed.success) {
    return jsonFromError(
      new ValidationError(parsed.error.issues.map((i) => i.message).join("; ")),
    );
  }

  const svc = getServiceClient();
  const { scout_id } = parsed.data;
  let { run_id } = parsed.data;

  // 1. Load scout.
  const { data: scout, error: scoutErr } = await svc
    .from("scouts")
    .select(
      "id, user_id, type, name, config, is_active, regularity, baseline_established_at",
    )
    .eq("id", scout_id)
    .maybeSingle();
  if (scoutErr) return jsonFromError(new Error(scoutErr.message));
  if (!scout) return jsonFromError(new NotFoundError("scout"));
  if (scout.type !== "transport") {
    return jsonFromError(
      new ValidationError(`scout ${scout_id} is not a transport scout`),
    );
  }

  // 2. Ensure OUR scout_runs row exists first (30-day TTL — sub-daily
  // volume). Rows pre-created by trigger_scout_run (Run Now) get their
  // expires_at tightened to the transport TTL here.
  let ourStartedAt: string;
  if (!run_id) {
    const { data: runRow, error: runErr } = await svc
      .from("scout_runs")
      .insert({
        scout_id: scout.id,
        user_id: scout.user_id,
        status: "running",
        started_at: new Date().toISOString(),
        expires_at: transportRunExpiresAt(),
      })
      .select("id, started_at")
      .single();
    if (runErr) return jsonFromError(new Error(runErr.message));
    run_id = runRow.id as string;
    ourStartedAt = runRow.started_at as string;
  } else {
    const { data: runRow, error: runErr } = await svc
      .from("scout_runs")
      .update({ expires_at: transportRunExpiresAt() })
      .eq("id", run_id)
      .select("id, started_at")
      .single();
    if (runErr) return jsonFromError(new Error(runErr.message));
    ourStartedAt = runRow.started_at as string;
  }
  const runId = run_id as string;

  // 3. Overlap election — every dispatcher owns a running row by now; only
  // the oldest row within the grace window proceeds (deterministic tiebreak
  // in shouldYieldToPeer), so concurrent dispatches can neither double-run
  // nor mutually skip. Losers mark their own run skipped, unbilled.
  const { data: runningRows, error: runningErr } = await svc
    .from("scout_runs")
    .select("id, started_at")
    .eq("scout_id", scout.id)
    .eq("status", "running")
    .gte("started_at", overlapCutoffIso());
  if (runningErr) return jsonFromError(new Error(runningErr.message));
  const peers = (runningRows ?? []) as { id: string; started_at: string }[];
  if (shouldYieldToPeer({ id: runId, started_at: ourStartedAt }, peers)) {
    logEvent({
      level: "info",
      fn: "scout-transport-execute",
      event: "overlap_skip",
      scout_id: scout.id,
      run_id: runId,
      msg: "yielding to an older concurrent run of this scout",
    });
    await markRunError(svc, runId, {
      stage: "dispatch",
      errorClass: "validation",
      message: "skipped: another run of this scout is still in flight",
      status: "skipped",
    });
    return jsonOk({ status: "skipped", reason: "overlapping_run" });
  }
  await markRunStage(svc, runId, "dispatch");

  // 4. Non-billable pre-checks. A misconfigured scout must never charge.
  const precheck = precheckTransportScout(scout.config);
  if (!precheck.ok) {
    await markRunError(svc, runId, {
      stage: "dispatch",
      errorClass: "validation",
      message: precheck.error ?? "invalid transport config",
    });
    return jsonFromError(
      new ValidationError(precheck.error ?? "invalid config"),
    );
  }

  // 5. Mode gate — still a non-billable pre-check. Vessel lands in U3,
  // satellite in U4; until then those modes skip unbilled.
  if (!IMPLEMENTED_MODES.has(precheck.mode!)) {
    const message =
      `transport ${precheck.mode} execution is not yet enabled on this deployment`;
    await markRunError(svc, runId, {
      stage: "dispatch",
      errorClass: "validation",
      message,
      status: "skipped",
    });
    logEvent({
      level: "info",
      fn: "scout-transport-execute",
      event: "mode_not_enabled",
      scout_id: scout.id,
      run_id: runId,
      msg: message,
    });
    return jsonOk({ status: "skipped", reason: "mode_not_enabled" });
  }

  // 5b. Vessel sampler-liveness pre-check — NON-BILLABLE, before the charge.
  // Vessel runs read the shared sampler cache; if the sampler itself is stale
  // (no fresh positions ANYWHERE — sampler down or still starting), the run
  // SKIPS unbilled with frozen state clocks rather than reporting a false "no
  // traffic", and a run of consecutive skips escalates so a dead sampler is
  // visible (R16). A healthy sampler over a quiet area is NOT stale — it runs
  // normally and simply finds zero entrants (the fix for empty geofences
  // auto-deactivating healthy scouts). Wrapped so a transient DB error or a
  // vanished preset marks the run error instead of orphaning a running row.
  let prefetchedVessels: VesselObject[] | null = null;
  let prefetchedGeofence: Awaited<ReturnType<typeof resolveGeofence>> = null;
  if (precheck.mode === "vessel") {
    try {
      await markRunStage(svc, runId, "scrape");
      prefetchedGeofence = await resolveGeofence(svc, precheck.config!);
      if (!prefetchedGeofence) {
        await markRunError(svc, runId, {
          stage: "dispatch",
          errorClass: "validation",
          message: "vessel scout has no geofence",
          status: "skipped",
        });
        return jsonOk({ status: "skipped", reason: "no_geofence" });
      }
      const sampler = await isSamplerFresh(
        svc,
        (scout.regularity as string | null) ?? null,
      );
      if (!sampler.fresh) {
        // Shared-infrastructure staleness (sampler down/behind) is NOT the
        // scout's fault, so it records a visible skip but must NOT feed the
        // failure counter — otherwise a sampler outage would auto-deactivate
        // every vessel scout fleet-wide, with recovery deadlock. The scout
        // stays active and resumes automatically when the sampler recovers.
        await markRunError(svc, runId, {
          stage: "scrape",
          errorClass: "provider",
          message: sampler.freshestSeenAt
            ? `AIS sampler stale (freshest position ${sampler.freshestSeenAt}); sampler may be behind`
            : "no AIS positions yet; sampler may be starting up",
          status: "skipped",
        });
        logEvent({
          level: "warn",
          fn: "scout-transport-execute",
          event: "vessel_sampler_stale_skip",
          scout_id: scout.id,
          run_id: runId,
          msg: sampler.freshestSeenAt ?? "no positions",
        });
        return jsonOk({ status: "skipped", reason: "sampler_stale" });
      }
      prefetchedVessels = await fetchVesselsInGeofence(
        svc,
        prefetchedGeofence,
      );
    } catch (e) {
      const classified = classifyRunError(e, "scrape");
      await markRunError(svc, runId, {
        stage: classified.stage,
        errorClass: classified.errorClass,
        message: classified.message,
      });
      return jsonFromError(e);
    }
  }

  // 5c. Satellite GP-cache liveness pre-check — NON-BILLABLE. If the GP cache
  // is globally stale (daily refresh down / not run yet), predictions would be
  // unreliable, so the run SKIPS unbilled. Like the vessel sampler check this
  // is shared-infra staleness, so it does NOT feed the failure counter (no
  // fleet-wide auto-deactivation cascade); the scout resumes when the GP
  // refresh recovers. A globally-fresh cache over a geofence a satellite never
  // crosses is a normal success with zero passes.
  let prefetchedElements: GpElement[] | null = null;
  if (precheck.mode === "satellite") {
    try {
      await markRunStage(svc, runId, "scrape");
      prefetchedGeofence = await resolveGeofence(svc, precheck.config!);
      if (!prefetchedGeofence) {
        await markRunError(svc, runId, {
          stage: "dispatch",
          errorClass: "validation",
          message: "satellite scout has no geofence",
          status: "skipped",
        });
        return jsonOk({ status: "skipped", reason: "no_geofence" });
      }
      const gp = await isGpCacheFresh(svc);
      if (!gp.fresh) {
        await markRunError(svc, runId, {
          stage: "scrape",
          errorClass: "provider",
          message: gp.freshestFetchedAt
            ? `orbital-element cache stale (freshest ${gp.freshestFetchedAt}); GP refresh may be behind`
            : "no orbital elements cached yet; GP refresh may be starting up",
          status: "skipped",
        });
        logEvent({
          level: "warn",
          fn: "scout-transport-execute",
          event: "satellite_gp_stale_skip",
          scout_id: scout.id,
          run_id: runId,
          msg: gp.freshestFetchedAt ?? "no elements",
        });
        return jsonOk({ status: "skipped", reason: "gp_stale" });
      }
      const noradIds = (precheck.config!.watch_ids ?? [])
        .map((id) => Number(id))
        .filter((n) => Number.isInteger(n) && n > 0);
      // Best-effort: watched ids absent from GROUP=active just yield no
      // passes (logged), rather than failing the whole run.
      prefetchedElements = await fetchWatchedElements(svc, noradIds);
      const missing = noradIds.filter((id) =>
        !prefetchedElements!.some((e) => e.noradId === id)
      );
      if (missing.length > 0) {
        logEvent({
          level: "info",
          fn: "scout-transport-execute",
          event: "satellite_ids_uncached",
          scout_id: scout.id,
          run_id: runId,
          msg: `not in active catalog: ${missing.join(",")}`,
        });
      }
    } catch (e) {
      const classified = classifyRunError(e, "scrape");
      await markRunError(svc, runId, {
        stage: classified.stage,
        errorClass: classified.errorClass,
        message: classified.message,
      });
      return jsonFromError(e);
    }
  }

  // 5d. Aircraft watchlist-loaded pre-check — NON-BILLABLE. A gov/police/civil
  // scout whose watchlist table is empty (never imported / import aborted)
  // would otherwise filter to zero and silently report "no traffic" forever.
  // Treat an unloaded watchlist as setup-not-ready: skip without charging or
  // auto-deactivating; the scout works once refresh-transport-watchlists runs.
  if (precheck.mode === "aircraft") {
    try {
      const populated = await watchlistPopulated(
        svc,
        precheck.config!.categories ?? [],
      );
      if (!populated) {
        await markRunError(svc, runId, {
          stage: "scrape",
          errorClass: "provider",
          message:
            "aircraft watchlist not loaded for the requested category; run refresh-transport-watchlists",
          status: "skipped",
        });
        logEvent({
          level: "warn",
          fn: "scout-transport-execute",
          event: "watchlist_unloaded_skip",
          scout_id: scout.id,
          run_id: runId,
        });
        return jsonOk({ status: "skipped", reason: "watchlist_unloaded" });
      }
    } catch (e) {
      const classified = classifyRunError(e, "scrape");
      await markRunError(svc, runId, {
        stage: classified.stage,
        errorClass: classified.errorClass,
        message: classified.message,
      });
      return jsonFromError(e);
    }
  }

  // 6. Charge the BASE credit before billable work. The +1 criteria addon is
  // NOT charged here — it is charged in Phase B only when the LLM criteria
  // pass actually ran over entrants and succeeded, so zero-entrant runs and
  // fail-open (broken-LLM) runs never pay the surcharge.
  let chargedCredits = false;
  const runCost = getTransportCost(false); // base only; addon deferred
  try {
    await markRunStage(svc, runId, "credits");
    await decrementOrThrow(svc, {
      userId: scout.user_id,
      cost: runCost,
      scoutId: scout.id,
      scoutType: "transport",
      operation: "transport",
    });
    chargedCredits = true;
  } catch (e) {
    if (e instanceof InsufficientCreditsError) {
      await markRunError(svc, runId, {
        stage: "credits",
        errorClass: "quota",
        message: e.message,
        status: "skipped",
      });
      return insufficientCreditsResponse(e.required, e.current);
    }
    const classified = classifyRunError(e, "credits");
    await markRunError(svc, runId, {
      stage: classified.stage,
      errorClass: classified.errorClass,
      message: classified.message,
    });
    return jsonFromError(e);
  }

  // 7. Aircraft pipeline — Phase A (billable work): fetch → filter → state
  // diff/claim → feed units → baseline stamp. A throw here rolls back the
  // alert claims of undelivered entrants (so their alerts fire on a later
  // run), refunds, marks the run error, and counts toward failure auto-pause.
  let claimed: string[] = [];
  let delivered: string[] = [];
  let events: EntrantEvent[] = [];
  let scope: AlertScope = { name: "watch list", isWatchlist: true };
  let baselineRun = false;
  let matchedCount = 0;
  let evictedCount = 0;
  let criteriaRan = false;
  let criteriaOk = true;
  let llmRan = false;
  try {
    const config = precheck.config!;
    const now = new Date();
    // Reuse the geofence resolved in the vessel/satellite pre-check; aircraft
    // resolves here (no pre-check ran for it).
    const geofence = precheck.mode === "aircraft"
      ? await resolveGeofence(svc, config)
      : prefetchedGeofence;
    scope = geofence
      ? { name: geofence.name, isWatchlist: false }
      : { name: "watch list", isWatchlist: true };

    // Per-mode: produce matched object ids + a statement for each.
    const statements = new Map<string, string>();
    let matchedIds: string[] = [];
    if (precheck.mode === "vessel") {
      // Reuse the non-billable pre-fetch (staleness already passed).
      const matched = filterVessels(config, prefetchedVessels ?? []);
      matchedIds = matched.map((v) => v.id);
      for (const v of matched) {
        statements.set(v.id, composeVesselStatement(v, scope, now));
      }
    } else if (precheck.mode === "satellite") {
      // Predict passes for each watched element over the next 24h. Each
      // pass window is an "entrant" keyed stably so it alerts once.
      for (const element of prefetchedElements ?? []) {
        for (const pass of predictPasses(element, geofence!, now)) {
          const key = passStateKey(pass);
          matchedIds.push(key);
          statements.set(key, composeSatelliteStatement(pass, scope.name));
        }
      }
    } else {
      await markRunStage(svc, runId, "scrape");
      const candidates = await fetchAircraftCandidates(config, geofence);
      // Resolve watchlist categories (plane-alert-db) for the candidate hexes.
      const watchlistHexes = await fetchWatchlistHexes(
        svc,
        candidates.map((a) => a.id),
        config.categories ?? [],
      );
      const matched = filterAircraft(config, candidates, watchlistHexes);
      matchedIds = matched.map((a) => a.id);
      for (const a of matched) {
        statements.set(a.id, composeAircraftStatement(a, scope, now));
      }
    }
    // Dedup object ids before the state upsert: two satellite pass windows
    // whose starts round to the same 10-min key would otherwise appear twice
    // and crash the ON CONFLICT upsert. The statements Map already holds one
    // entry per unique id, so its keys ARE the deduped set.
    matchedIds = [...statements.keys()];
    matchedCount = matchedIds.length;

    await markRunStage(svc, runId, "diff");
    const baselineEstablished = Boolean(scout.baseline_established_at);
    const sync = await syncStateAndClaimEntrants(svc, {
      scoutId: scout.id,
      userId: scout.user_id,
      objectIds: matchedIds,
      regularity: (scout.regularity as string | null) ?? null,
      baselineEstablished,
    });
    claimed = sync.entrants;
    baselineRun = sync.baselineRun;
    evictedCount = sync.evicted;

    // Candidate entrants (newly-claimed objects). claimed ⊆ statements.keys()
    // so every claimed id has a statement.
    const candidateEvents = claimed
      .map((id) => ({ objectId: id, statement: statements.get(id)! }));

    // Free-text criteria: an LLM pass over the (small) entrant set only.
    // Fails OPEN — an LLM error keeps all entrants and records the error.
    const hasCriteria = precheck.hasCriteria === true;
    const criteria = await applyCriteria(config.criteria, candidateEvents);
    criteriaRan = hasCriteria;
    criteriaOk = criteria.ok;
    // The LLM only actually runs with criteria set AND ≥1 candidate.
    llmRan = hasCriteria && candidateEvents.length > 0;
    const kept = new Set(criteria.keptIds);
    events = candidateEvents.filter((e) => kept.has(e.objectId));

    // Entrants the criteria SUPPRESSED are unclaimed so they are re-judged on
    // a later run — a single LLM false-negative must not permanently silence a
    // genuinely-matching object for as long as it stays in the area.
    const suppressed = candidateEvents
      .map((e) => e.objectId)
      .filter((id) => !kept.has(id));
    if (suppressed.length > 0) {
      await unclaimEntrants(svc, scout.id, suppressed);
    }

    if (events.length > 0) {
      await markRunStage(svc, runId, "insert_units");
      await writeEntrantUnits(svc, {
        scoutId: scout.id,
        userId: scout.user_id,
        runId,
        events,
        areaName: scope.name,
        sourceDomain: MODE_SOURCE[precheck.mode!].domain,
      });
    }
    delivered = events.map((ev) => ev.objectId);

    // Baseline stamp is load-bearing: an unstamped scout reruns a billed
    // silent baseline AND pre-claims genuine entrants. Checked, and inside
    // Phase A so a failure refunds this (deliverable-free) baseline run.
    if (!baselineEstablished) {
      const { error: stampErr } = await svc
        .from("scouts")
        .update({ baseline_established_at: new Date().toISOString() })
        .eq("id", scout.id);
      if (stampErr) {
        throw new Error(`baseline stamp failed: ${stampErr.message}`);
      }
    }
  } catch (e) {
    if (e instanceof UnitWriteError) delivered = e.written;
    // Only unclaim entrants we INTENDED to deliver (passed criteria) but
    // didn't — those must re-alert next run. Criteria-suppressed entrants
    // stay claimed and are not in `events`.
    const intended = events.map((ev) => ev.objectId);
    const undelivered = intended.filter((id) => !delivered.includes(id));
    try {
      await unclaimEntrants(svc, scout.id, undelivered);
    } catch (unclaimErr) {
      logEvent({
        level: "error",
        fn: "scout-transport-execute",
        event: "unclaim_failed",
        scout_id: scout.id,
        run_id: runId,
        msg: `${undelivered.length} entrant claims stuck: ${
          unclaimErr instanceof Error ? unclaimErr.message : String(unclaimErr)
        }`,
      });
    }
    if (chargedCredits) {
      await refundCredits(svc, {
        userId: scout.user_id,
        cost: runCost,
        scoutId: scout.id,
        scoutType: "transport",
        operation: "transport",
      });
    }
    const classified = classifyRunError(e, "scrape");
    await markRunError(svc, runId, {
      stage: classified.stage,
      errorClass: classified.errorClass,
      message: classified.message,
    });
    if (shouldIncrementScoutFailure(classified.errorClass)) {
      await incrementAndMaybeNotify(svc, {
        scoutId: scout.id,
        userId: scout.user_id,
        scoutName: scout.name as string,
        scoutType: "transport",
      });
    }
    return jsonFromError(e);
  }

  // 8. Phase B (finalization after delivered work): never refunds, never
  // overwrites the run with an error, never feeds the failure counter. Each
  // step is individually guarded — a failed markRunSuccess leaves the row
  // 'running' for the stale-run sweeper rather than clawing back real work.
  try {
    await markRunSuccess(svc, runId, {
      unitsCreated: events.length,
      unitsMerged: 0,
      // true only when criteria ran AND the LLM succeeded; a fail-open run
      // records false + an error note so the degraded pass is visible.
      criteriaStatus: criteriaRan && criteriaOk,
      errorMessage: criteriaRan && !criteriaOk
        ? "criteria evaluation failed; all entrants kept (fail-open)"
        : null,
      notificationStatus: events.length > 0 ? "pending" : "skipped",
      sourcesScraped: 1,
      sourcesFailed: 0,
    });
  } catch (finalizeErr) {
    logEvent({
      level: "warn",
      fn: "scout-transport-execute",
      event: "finalize_failed",
      scout_id: scout.id,
      run_id: runId,
      msg: finalizeErr instanceof Error
        ? finalizeErr.message
        : String(finalizeErr),
    });
  }

  // Deferred +1 criteria addon — charged ONLY when the LLM pass actually ran
  // over entrants AND succeeded, so zero-entrant runs and fail-open
  // (broken-LLM) runs never pay the surcharge. Post-success, best-effort: the
  // work is delivered, so a 1-credit charge failure is logged, not fatal.
  if (llmRan && criteriaOk) {
    try {
      await decrementOrThrow(svc, {
        userId: scout.user_id,
        cost: CREDIT_COSTS.transport_criteria_addon,
        scoutId: scout.id,
        scoutType: "transport",
        operation: "transport_criteria_addon",
      });
    } catch (addonErr) {
      logEvent({
        level: "warn",
        fn: "scout-transport-execute",
        event: "criteria_addon_charge_failed",
        scout_id: scout.id,
        run_id: runId,
        msg: addonErr instanceof Error ? addonErr.message : String(addonErr),
      });
    }
  }

  try {
    const { error: resetErr } = await svc.rpc("reset_scout_failures", {
      p_scout_id: scout.id,
    });
    if (resetErr) throw new Error(resetErr.message);
  } catch (resetErr) {
    logEvent({
      level: "warn",
      fn: "scout-transport-execute",
      event: "failure_reset_failed",
      scout_id: scout.id,
      run_id: runId,
      msg: resetErr instanceof Error ? resetErr.message : String(resetErr),
    });
  }

  if (events.length > 0) {
    await markNotificationAttempted(svc, runId).catch(() => {});
    const notification = await sendTransportScoutAlert(svc, {
      userId: scout.user_id,
      scoutId: scout.id,
      runId,
      scoutName: scout.name as string,
      areaName: scope.name,
      isWatchlist: scope.isWatchlist,
      mode: precheck.mode!,
      sourceLabel: MODE_SOURCE[precheck.mode!].label,
      entrantStatements: events.map((ev) => ev.statement),
    });
    // guarded() never throws — resolve the run's notification status from
    // its result so nothing stays 'pending' forever (mirrors web executor).
    const status = notification.ok
      ? "sent"
      : notification.reason === "missing_email"
      ? "skipped"
      : "failed";
    await markNotificationResult(svc, runId, status, {
      providerId: notification.providerId ?? null,
      reason: notification.reason ?? null,
      message: notification.error ?? null,
    }).catch((markErr) =>
      logEvent({
        level: "warn",
        fn: "scout-transport-execute",
        event: "notify_status_update_failed",
        scout_id: scout.id,
        run_id: runId,
        msg: markErr instanceof Error ? markErr.message : String(markErr),
      })
    );
  }

  return jsonOk({
    status: "success",
    baseline_run: baselineRun,
    matched: matchedCount,
    entrants: events.length,
    evicted: evictedCount,
  });
});

<script lang="ts">
	import { slide } from 'svelte/transition';
	import FormPanel from '$lib/components/ui/FormPanel.svelte';
	import TogglePicker from '$lib/components/ui/TogglePicker.svelte';
	import CriteriaInput from '$lib/components/ui/CriteriaInput.svelte';
	import ScoutScheduleModal from '$lib/components/modals/ScoutScheduleModal.svelte';
	import {
		TRANSPORT_ID_SOURCES,
		TRANSPORT_PRESETS,
		transportModeCategories,
		transportParseNum,
		transportWatchIdValid
	} from '$lib/utils/transport';
	import * as m from '$lib/paraglide/messages';

	export let onScheduled: (detail: { scoutType: 'transport' }) => void = () => {};

	type Mode = 'aircraft' | 'vessel' | 'satellite';
	type GeofenceKind = 'none' | 'preset' | 'radius';

	// Must mirror the backend caps in _shared/transport_config.ts.
	const AIRCRAFT_MAX_RADIUS_KM = 463;
	const MAX_RADIUS_KM = 1500;

	let mode: Mode = 'aircraft';
	let name = '';
	// Aircraft may watch IDs with no area; vessel/satellite require an area.
	let geofenceKind: GeofenceKind = 'preset';
	let presetId = TRANSPORT_PRESETS[0].id;
	let centerLat = '';
	let centerLon = '';
	let radiusKm = '100';
	let watchIdsRaw = '';
	let selectedCategories: string[] = [];
	let criteria = '';
	let error = '';
	let showScheduleModal = false;

	// Vessel/satellite require an area — force a geofence kind when switching.
	$: if (mode !== 'aircraft' && geofenceKind === 'none') geofenceKind = 'preset';
	$: availableCategories = transportModeCategories(mode);
	$: geofenceRequired = mode !== 'aircraft';
	$: radiusCapKm = mode === 'aircraft' ? AIRCRAFT_MAX_RADIUS_KM : MAX_RADIUS_KM;
	$: idSource = TRANSPORT_ID_SOURCES[mode];
	$: watchIdsHint =
		mode === 'vessel'
			? m.transport_watchIdsHintVessel()
			: mode === 'aircraft'
				? m.transport_watchIdsHintAircraft()
				: m.transport_watchIdsHintSatellite();

	const parseNum = transportParseNum;

	function toggleCategory(cat: string) {
		selectedCategories = selectedCategories.includes(cat)
			? selectedCategories.filter((c) => c !== cat)
			: [...selectedCategories, cat];
	}

	function parsedWatchIds(): string[] {
		return watchIdsRaw
			.split(/[\s,]+/)
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean);
	}

	// Derived reactively: a Svelte template/`$:` expression only re-runs when a
	// variable it *textually references* changes, so these must read the form
	// state directly (not hide it behind a plain function call) — otherwise the
	// modal would receive the initial defaults and never the user's edits.
	$: builtConfig = ((): Record<string, unknown> => {
		const config: Record<string, unknown> = { mode };
		if (geofenceKind === 'preset') {
			config.geofence = { preset_id: presetId };
		} else if (geofenceKind === 'radius') {
			config.geofence = {
				center: { lat: parseNum(centerLat), lon: parseNum(centerLon) },
				radius_km: parseNum(radiusKm)
			};
		}
		const watchIds = watchIdsRaw
			.split(/[\s,]+/)
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean);
		if (watchIds.length > 0) config.watch_ids = watchIds;
		if (selectedCategories.length > 0) config.categories = selectedCategories;
		if (criteria.trim()) config.criteria = criteria.trim();
		return config;
	})();

	/** Human-readable area for the schedule modal's context block. */
	$: areaLbl =
		geofenceKind === 'preset'
			? (TRANSPORT_PRESETS.find((p) => p.id === presetId)?.name ?? presetId)
			: geofenceKind === 'radius'
				? `${centerLat || '?'}, ${centerLon || '?'} · ${radiusKm || '?'} km`
				: m.transport_areaNone();

	/** Full client-side validation mirroring the backend, so users get inline
	 * errors before the schedule modal opens. Returns an error string or ''. */
	function validate(): string {
		if (!name.trim()) return m.transport_errorName();

		const watchIds = parsedWatchIds();
		const hasGeofence = geofenceKind !== 'none';

		// Watch IDs are mandatory for every mode — area/category-only scouts
		// would alert on all matching traffic (product decision 2026-07-04).
		if (watchIds.length === 0) return m.transport_errorWatchIdsRequired();
		if (geofenceRequired && !hasGeofence) return m.transport_errorGeofence();

		if (geofenceKind === 'radius') {
			const lat = parseNum(centerLat);
			const lon = parseNum(centerLon);
			const r = parseNum(radiusKm);
			if (!Number.isFinite(lat) || lat < -90 || lat > 90) return m.transport_errorLat();
			if (!Number.isFinite(lon) || lon < -180 || lon > 180) return m.transport_errorLon();
			if (!Number.isFinite(r) || r <= 0 || r > radiusCapKm) {
				return m.transport_errorRadius({ max: radiusCapKm });
			}
		}

		for (const id of watchIds) {
			if (!transportWatchIdValid(mode, id)) return m.transport_errorWatchIdFormat({ id });
		}
		return '';
	}

	function openSchedule() {
		error = validate();
		if (error) return;
		showScheduleModal = true;
	}

	function resetForm() {
		name = '';
		geofenceKind = 'preset';
		presetId = TRANSPORT_PRESETS[0].id;
		centerLat = '';
		centerLon = '';
		radiusKm = '100';
		watchIdsRaw = '';
		selectedCategories = [];
		criteria = '';
		error = '';
	}
</script>

<div class="panel-view">
	<div class="query-column">
		<FormPanel
			badge={m.modal_transportScoutBadge()}
			badgeVariant="purple"
			title={m.transport_panelTitle()}
			subtitle={m.transport_trackDescription()}
		>
			<!-- Scout Name -->
			<div class="field-group">
				<label for="transport-name" class="field-label">{m.transport_nameLabel()}</label>
				<input
					id="transport-name"
					type="text"
					bind:value={name}
					maxlength="30"
					placeholder={m.transport_namePlaceholder()}
					class="form-input"
				/>
			</div>

			<!-- Mode -->
			<div class="field-group">
				<div class="field-label">{m.transport_modeLabel()}</div>
				<TogglePicker
					bind:value={mode}
					options={[
						{ value: 'aircraft', label: m.transport_modeAircraft(), description: 'ADS-B' },
						{ value: 'vessel', label: m.transport_modeVessel(), description: 'AIS' },
						{ value: 'satellite', label: m.transport_modeSatellite(), description: 'Orbital' }
					]}
				/>
			</div>

			<!-- Area -->
			<div class="field-group">
				<div class="field-label">
					{m.transport_areaLabel()}
					{#if geofenceRequired}<span class="req">*</span>{/if}
				</div>
				<div class="area-kind">
					<label><input type="radio" bind:group={geofenceKind} value="preset" /> {m.transport_areaPreset()}</label>
					<label><input type="radio" bind:group={geofenceKind} value="radius" /> {m.transport_areaRadius()}</label>
					{#if !geofenceRequired}
						<label><input type="radio" bind:group={geofenceKind} value="none" /> {m.transport_areaNone()}</label>
					{/if}
				</div>
				{#if geofenceKind === 'preset'}
					<select class="form-select" bind:value={presetId}>
						{#each TRANSPORT_PRESETS as p}
							<option value={p.id}>{p.name}</option>
						{/each}
					</select>
				{:else if geofenceKind === 'radius'}
					<div class="radius-row">
						<input class="form-input" bind:value={centerLat} placeholder={m.transport_lat()} inputmode="decimal" />
						<input class="form-input" bind:value={centerLon} placeholder={m.transport_lon()} inputmode="decimal" />
						<input class="form-input" bind:value={radiusKm} placeholder={m.transport_radiusKm()} inputmode="numeric" />
					</div>
				{/if}
			</div>

			<!-- Watch IDs (mandatory for every mode) -->
			<div class="field-group">
				<label for="transport-watch-ids" class="field-label">
					{m.transport_watchIdsLabel()}
					<span class="req">*</span>
				</label>
				<input
					id="transport-watch-ids"
					type="text"
					bind:value={watchIdsRaw}
					placeholder={m.transport_watchIdsPlaceholder()}
					required
					class="form-input"
				/>
				<p class="field-hint">
					{watchIdsHint}
					<a href={idSource.url} target="_blank" rel="noopener noreferrer">{idSource.label}</a>.
				</p>
			</div>

			<!-- Categories -->
			{#if availableCategories.length > 0}
				<div class="field-group">
					<div class="field-label">{m.transport_categoriesLabel()}</div>
					<div class="chips">
						{#each availableCategories as cat}
							<button
								type="button"
								class="chip"
								class:selected={selectedCategories.includes(cat)}
								on:click={() => toggleCategory(cat)}
							>
								{cat}
							</button>
						{/each}
					</div>
				</div>
			{/if}

			<!-- Criteria -->
			<div class="field-group">
				<label for="transport-criteria" class="field-label">{m.transport_criteriaLabel()}</label>
				<CriteriaInput
					bind:value={criteria}
					placeholder={m.transport_criteriaPlaceholder()}
					rows={2}
				/>
				<p class="field-hint">{m.transport_criteriaHint()}</p>
			</div>

			{#if error}
				<p class="error-text" transition:slide={{ duration: 150 }}>{error}</p>
			{/if}

			<button type="button" class="btn-primary schedule-btn" on:click={openSchedule}>
				{m.scout_scheduleScout()}
			</button>
		</FormPanel>
	</div>
</div>

<ScoutScheduleModal
	bind:open={showScheduleModal}
	scoutType="transport"
	scoutName={name.trim()}
	transportMode={mode}
	transportConfig={builtConfig}
	transportAreaLabel={areaLbl}
	onClose={() => (showScheduleModal = false)}
	onSuccess={() => {
		showScheduleModal = false;
		resetForm();
		onScheduled({ scoutType: 'transport' });
	}}
/>

<style>
	.field-group {
		margin-bottom: 1rem;
	}
	.field-label {
		display: block;
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--color-ink);
		margin-bottom: 0.5rem;
	}
	.field-hint {
		font-size: 0.75rem;
		color: var(--color-ink-subtle);
		margin: 0.375rem 0 0;
		line-height: 1.4;
	}
	.field-hint a {
		color: var(--color-primary);
		text-decoration: underline;
	}
	.req {
		color: var(--color-error);
	}
	.area-kind {
		display: flex;
		gap: 1rem;
		margin-bottom: 0.5rem;
	}
	.area-kind label {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 0.8125rem;
		color: var(--color-ink-muted);
	}
	.radius-row {
		display: flex;
		gap: 0.5rem;
	}
	.radius-row .form-input {
		flex: 1;
		min-width: 0;
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.375rem;
	}
	.chip {
		padding: 0.3125rem 0.625rem;
		border: 1px solid var(--color-border);
		background: var(--color-surface);
		font-size: 0.75rem;
		cursor: pointer;
		color: var(--color-ink-muted);
		font-family: var(--font-body);
	}
	.chip.selected {
		border-color: var(--color-primary);
		background: var(--color-primary-soft);
		color: var(--color-primary-deep);
	}
	.error-text {
		margin: 0 0 1rem 0;
		padding: 0.5rem 0.75rem;
		background: rgba(179, 62, 46, 0.08);
		border-left: 3px solid var(--color-error);
		color: var(--color-error);
		font-size: 0.8125rem;
	}
	.schedule-btn {
		width: 100%;
	}
</style>

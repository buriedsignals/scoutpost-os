<script lang="ts">
	import { workspaceApi } from '$lib/api-client';
	import { authStore } from '$lib/stores/auth';
	import * as m from '$lib/paraglide/messages';
	import {
		TRANSPORT_PRESETS,
		transportModeCategories,
		transportParseNum,
		transportRegularities,
		transportWatchIdValid
	} from '$lib/utils/transport';

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
	let regularity: '3h' | '6h' | '12h' | 'daily' = '3h';
	let time = '09:00';
	let submitting = false;
	let error = '';

	// Satellite is daily-only; reset regularity when switching to it.
	$: if (mode === 'satellite' && regularity !== 'daily') regularity = 'daily';
	// Vessel/satellite require an area — force a geofence kind when switching.
	$: if (mode !== 'aircraft' && geofenceKind === 'none') geofenceKind = 'preset';
	$: availableCategories = transportModeCategories(mode);
	$: availableRegularities = transportRegularities(mode);
	$: geofenceRequired = mode !== 'aircraft';
	$: watchIdsRequired = mode === 'satellite';
	$: radiusCapKm = mode === 'aircraft' ? AIRCRAFT_MAX_RADIUS_KM : MAX_RADIUS_KM;

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

	const parseNum = transportParseNum;

	function monthlyCredits(): number {
		const perRun = 1 + (criteria.trim() ? 1 : 0);
		const mult: Record<string, number> = { '3h': 240, '6h': 120, '12h': 60, daily: 30 };
		return perRun * (mult[regularity] ?? 30);
	}

	function buildConfig(): Record<string, unknown> {
		const config: Record<string, unknown> = { mode };
		if (geofenceKind === 'preset') {
			config.geofence = { preset_id: presetId };
		} else if (geofenceKind === 'radius') {
			config.geofence = {
				center: { lat: parseNum(centerLat), lon: parseNum(centerLon) },
				radius_km: parseNum(radiusKm)
			};
		}
		const watchIds = parsedWatchIds();
		if (watchIds.length > 0) config.watch_ids = watchIds;
		if (selectedCategories.length > 0) config.categories = selectedCategories;
		if (criteria.trim()) config.criteria = criteria.trim();
		return config;
	}

	/** Full client-side validation mirroring the backend, so users get inline
	 * errors instead of confusing server 400s. Returns an error string or ''. */
	function validate(): string {
		if (!name.trim()) return m.transport_errorName();

		const watchIds = parsedWatchIds();
		const hasGeofence = geofenceKind !== 'none';

		if (geofenceRequired && !hasGeofence) return m.transport_errorGeofence();
		if (watchIdsRequired && watchIds.length === 0) return m.transport_errorWatchIds();
		// Aircraft needs at least one of area / watch IDs.
		if (mode === 'aircraft' && !hasGeofence && watchIds.length === 0) {
			return m.transport_errorAircraftScope();
		}

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

	async function handleSubmit() {
		error = validate();
		if (error) return;

		// Credit pre-check (UX parity with other scout types): don't post a run
		// the user can't afford. The tier/upgrade routing lives in the Pro-gated
		// menu entry; here we just surface the shortfall.
		const currentCredits = $authStore.user?.credits ?? 0;
		if (currentCredits < monthlyCredits()) {
			error = m.transport_errorCredits({ credits: monthlyCredits() });
			return;
		}

		submitting = true;
		try {
			await workspaceApi.createScout({
				name: name.trim(),
				type: 'transport',
				regularity,
				time,
				config: buildConfig()
			});
			onScheduled({ scoutType: 'transport' });
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			submitting = false;
		}
	}
</script>

<div class="transport-view">
	<h2 class="transport-title">{m.transport_panelTitle()}</h2>

	<label class="field">
		<span class="field-label">{m.transport_nameLabel()}</span>
		<input class="field-input" bind:value={name} placeholder={m.transport_namePlaceholder()} />
	</label>

	<div class="field">
		<span class="field-label">{m.transport_modeLabel()}</span>
		<div class="mode-tabs">
			<button class="mode-tab" class:active={mode === 'aircraft'} on:click={() => (mode = 'aircraft')}>
				{m.transport_modeAircraft()}
			</button>
			<button class="mode-tab" class:active={mode === 'vessel'} on:click={() => (mode = 'vessel')}>
				{m.transport_modeVessel()}
			</button>
			<button class="mode-tab" class:active={mode === 'satellite'} on:click={() => (mode = 'satellite')}>
				{m.transport_modeSatellite()}
			</button>
		</div>
	</div>

	<div class="field">
		<span class="field-label">
			{m.transport_areaLabel()}
			{#if geofenceRequired}<span class="req">*</span>{/if}
		</span>
		<div class="geofence-kind">
			<label><input type="radio" bind:group={geofenceKind} value="preset" /> {m.transport_areaPreset()}</label>
			<label><input type="radio" bind:group={geofenceKind} value="radius" /> {m.transport_areaRadius()}</label>
			{#if !geofenceRequired}
				<label><input type="radio" bind:group={geofenceKind} value="none" /> {m.transport_areaNone()}</label>
			{/if}
		</div>
		{#if geofenceKind === 'preset'}
			<select class="field-input" bind:value={presetId}>
				{#each TRANSPORT_PRESETS as p}
					<option value={p.id}>{p.name}</option>
				{/each}
			</select>
		{:else}
			<div class="radius-row">
				<input class="field-input" bind:value={centerLat} placeholder={m.transport_lat()} inputmode="decimal" />
				<input class="field-input" bind:value={centerLon} placeholder={m.transport_lon()} inputmode="decimal" />
				<input class="field-input" bind:value={radiusKm} placeholder={m.transport_radiusKm()} inputmode="numeric" />
			</div>
		{/if}
	</div>

	<label class="field">
		<span class="field-label">
			{m.transport_watchIdsLabel()}
			{#if watchIdsRequired}<span class="req">*</span>{/if}
		</span>
		<input class="field-input" bind:value={watchIdsRaw} placeholder={m.transport_watchIdsPlaceholder()} />
		<span class="field-hint">{m.transport_watchIdsHint()}</span>
	</label>

	{#if availableCategories.length > 0}
		<div class="field">
			<span class="field-label">{m.transport_categoriesLabel()}</span>
			<div class="chips">
				{#each availableCategories as cat}
					<button
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

	<label class="field">
		<span class="field-label">{m.transport_criteriaLabel()}</span>
		<input class="field-input" bind:value={criteria} placeholder={m.transport_criteriaPlaceholder()} />
		<span class="field-hint">{m.transport_criteriaHint()}</span>
	</label>

	<div class="field">
		<span class="field-label">{m.transport_scheduleLabel()}</span>
		<div class="schedule-row">
			<select class="field-input" bind:value={regularity} disabled={mode === 'satellite'}>
				{#each availableRegularities as r}
					<option value={r.value}>{r.label}</option>
				{/each}
			</select>
			<input class="field-input" type="time" bind:value={time} />
		</div>
		<span class="field-hint">{m.transport_creditsEstimate({ credits: monthlyCredits() })}</span>
	</div>

	{#if error}
		<p class="error">{error}</p>
	{/if}

	<button class="submit" on:click={handleSubmit} disabled={submitting}>
		{submitting ? m.transport_creating() : m.transport_create()}
	</button>
</div>

<style>
	.transport-view {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		max-width: 560px;
		padding: 1.5rem;
		font-family: var(--font-body);
	}
	.transport-title {
		font-size: 1.25rem;
		font-weight: 600;
		color: var(--color-ink);
		margin: 0;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}
	.field-label {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--color-ink-muted);
	}
	.req {
		color: var(--color-secondary);
	}
	.field-input {
		padding: 0.5rem 0.625rem;
		border: 1px solid var(--color-border);
		background: var(--color-surface);
		font-size: 0.875rem;
		color: var(--color-ink);
	}
	.field-hint {
		font-size: 0.75rem;
		color: var(--color-ink-subtle);
	}
	.mode-tabs,
	.geofence-kind {
		display: flex;
		gap: 0.5rem;
	}
	.geofence-kind label {
		font-size: 0.8125rem;
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
	}
	.mode-tab {
		flex: 1;
		padding: 0.5rem;
		border: 1px solid var(--color-border);
		background: var(--color-surface);
		font-size: 0.8125rem;
		cursor: pointer;
		color: var(--color-ink-muted);
	}
	.mode-tab.active {
		border-color: var(--color-primary);
		background: var(--color-primary-soft);
		color: var(--color-primary);
		font-weight: 600;
	}
	.radius-row,
	.schedule-row {
		display: flex;
		gap: 0.5rem;
	}
	.radius-row .field-input,
	.schedule-row .field-input {
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
	}
	.chip.selected {
		border-color: var(--color-primary);
		background: var(--color-primary-soft);
		color: var(--color-primary);
	}
	.error {
		color: var(--color-error, #b33e2e);
		font-size: 0.8125rem;
		margin: 0;
	}
	.submit {
		padding: 0.625rem;
		border: none;
		background: var(--color-primary);
		color: var(--color-bg);
		font-size: 0.875rem;
		font-weight: 600;
		cursor: pointer;
	}
	.submit:disabled {
		opacity: 0.6;
		cursor: default;
	}
</style>

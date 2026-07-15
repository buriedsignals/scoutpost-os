<script lang="ts">
	import { tick } from 'svelte';
	import { slide } from 'svelte/transition';
	import FormPanel from '$lib/components/ui/FormPanel.svelte';
	import TogglePicker from '$lib/components/ui/TogglePicker.svelte';
	import CriteriaInput from '$lib/components/ui/CriteriaInput.svelte';
	import LocationAutocomplete from '$lib/components/ui/LocationAutocomplete.svelte';
	import ProgressIndicator from '$lib/components/ui/ProgressIndicator.svelte';
	import StepButtons from '$lib/components/ui/StepButtons.svelte';
	import ScoutScheduleModal from '$lib/components/modals/ScoutScheduleModal.svelte';
	import { buildApiUrl } from '$lib/config/api';
	import type { GeocodedLocation } from '$lib/types';
	import {
		TRANSPORT_ID_SOURCES,
		TRANSPORT_MAX_WATCH_IDS,
		transportModeCategories,
		transportParseNum,
		transportWatchIdValid
	} from '$lib/utils/transport';
	import * as m from '$lib/paraglide/messages';

	export let onScheduled: (detail: { scoutType: 'transport' }) => void = () => {};

	type Mode = 'aircraft' | 'vessel' | 'satellite';

	// Must mirror the backend caps in _shared/transport_config.ts.
	const AIRCRAFT_MAX_RADIUS_KM = 463;
	const MAX_RADIUS_KM = 1500;

	let mode: Mode = 'aircraft';
	let selectedLocation: GeocodedLocation | null = null;
	let radiusKm = '100';
	let watchIdsRaw = '';
	let selectedCategories: string[] = [];
	let criteria = '';
	let error = '';
	let areaInvalid = false;
	let areaControl: LocationAutocomplete;
	let showScheduleModal = false;
	let isTesting = false;
	let testSuccess = false;
	let testedConfigKey = '';
	let baselineIds: string[] = [];
	let preview: Array<{ id: string; label: string }> = [];

	$: availableCategories = transportModeCategories(mode);
	$: {
		const pruned = selectedCategories.filter((c) => availableCategories.includes(c));
		if (pruned.length !== selectedCategories.length) selectedCategories = pruned;
	}
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

	$: builtConfig = ((): Record<string, unknown> => {
		const config: Record<string, unknown> = { mode };
		const radius = parseNum(radiusKm);
		if (selectedLocation?.coordinates && Number.isFinite(radius)) {
			config.geofence = {
				center: selectedLocation.coordinates,
				radius_km: radius,
				display_name: selectedLocation.displayName,
				...(selectedLocation.maptilerId ? { maptiler_id: selectedLocation.maptilerId } : {})
			};
		}
		const watchIds = parsedWatchIds();
		if (watchIds.length > 0) config.watch_ids = watchIds;
		if (selectedCategories.length > 0) config.categories = selectedCategories;
		if (criteria.trim()) config.criteria = criteria.trim();
		return config;
	})();

	$: areaLbl = selectedLocation
		? `${selectedLocation.displayName} · ${radiusKm || '?'} km`
		: '';
	$: configKey = JSON.stringify(builtConfig);
	$: if (testSuccess && testedConfigKey && configKey !== testedConfigKey) {
		testSuccess = false;
		baselineIds = [];
		preview = [];
	}

	function validate(): string {
		const watchIds = parsedWatchIds();
		if (watchIds.length === 0) return m.transport_errorWatchIdsRequired();
		if (watchIds.length > TRANSPORT_MAX_WATCH_IDS) {
			return m.transport_errorWatchIdsMax({ max: TRANSPORT_MAX_WATCH_IDS });
		}
		if (!selectedLocation?.coordinates) return m.transport_errorGeofence();

		const r = parseNum(radiusKm);
		if (!Number.isFinite(r) || r <= 0 || r > radiusCapKm) {
			return m.transport_errorRadius({ max: radiusCapKm });
		}

		for (const id of watchIds) {
			if (!transportWatchIdValid(mode, id)) return m.transport_errorWatchIdFormat({ id });
		}
		return '';
	}

	async function testFleet() {
		error = validate();
		areaInvalid = Boolean(error && (!selectedLocation?.coordinates || error === m.transport_errorGeofence()));
		if (error) {
			if (areaInvalid) {
				await tick();
				areaControl?.focus();
			}
			return;
		}
		isTesting = true;
		testSuccess = false;
		baselineIds = [];
		preview = [];
		const requestedConfigKey = configKey;
		const requestedConfig = JSON.parse(requestedConfigKey) as Record<string, unknown>;
		try {
			const { authStore } = await import('$lib/stores/auth');
			const token = await authStore.getToken();
			const response = await fetch(buildApiUrl('/transport-test'), {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(token ? { Authorization: `Bearer ${token}` } : {})
				},
				body: JSON.stringify({ config: requestedConfig })
			});
			const data = await response.json().catch(() => ({})) as {
				valid?: boolean;
				detail?: string;
				error?: string;
				baseline_ids?: string[];
				preview?: Array<{ id: string; label: string }>;
			};
			if (!response.ok || !data.valid) {
				throw new Error(data.detail || data.error || m.transport_testFailed());
			}
			if (configKey !== requestedConfigKey) {
				error = m.transport_testChanged();
				return;
			}
			baselineIds = data.baseline_ids ?? [];
			preview = data.preview ?? [];
			testedConfigKey = requestedConfigKey;
			testSuccess = true;
		} catch (cause) {
			error = configKey === requestedConfigKey
				? cause instanceof Error ? cause.message : m.transport_testFailed()
				: m.transport_testChanged();
		} finally {
			isTesting = false;
		}
	}

	function resetForm() {
		selectedLocation = null;
		radiusKm = '100';
		watchIdsRaw = '';
		selectedCategories = [];
		criteria = '';
		error = '';
		areaInvalid = false;
		isTesting = false;
		testSuccess = false;
		testedConfigKey = '';
		baselineIds = [];
		preview = [];
	}
</script>

<div class="panel-view">
	<div class="two-column-layout">
		<div class="query-column">
			<FormPanel
				badge={m.modal_transportScoutBadge()}
				badgeVariant="purple"
				title={m.transport_panelTitle()}
				subtitle={m.transport_trackDescription()}
			>
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

				<div class="field-group">
					<label for="transport-area" class="field-label">
						{m.transport_areaLabel()} <span class="req">*</span>
					</label>
					<LocationAutocomplete
						bind:this={areaControl}
						inputId="transport-area"
						selectedLocation={selectedLocation}
						placeholder={m.transport_areaPlaceholder()}
						required={true}
						invalid={areaInvalid}
						describedBy="transport-area-hint transport-area-error"
						onSelect={(location) => {
							selectedLocation = location;
							areaInvalid = false;
						}}
						onClear={() => {
							selectedLocation = null;
						}}
					/>
					<div class="radius-row">
						<label for="transport-radius" class="field-label radius-label">{m.transport_radiusKm()}</label>
						<input
							id="transport-radius"
							class="form-input"
							bind:value={radiusKm}
							inputmode="decimal"
							aria-describedby="transport-area-hint"
						/>
					</div>
					<p id="transport-area-hint" class="field-hint">{m.transport_areaHint()}</p>
					{#if areaInvalid}
						<p id="transport-area-error" class="error-text" role="alert">{m.transport_errorGeofence()}</p>
					{/if}
				</div>

				<div class="field-group">
					<label for="transport-watch-ids" class="field-label">
						{m.transport_watchIdsLabel()} <span class="req">*</span>
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

				{#if availableCategories.length > 0}
					<div class="field-group">
						<div class="field-label">{m.transport_categoriesLabel()}</div>
						<div class="chips">
							{#each availableCategories as cat}
								<button type="button" class="chip" class:selected={selectedCategories.includes(cat)} on:click={() => toggleCategory(cat)}>{cat}</button>
							{/each}
						</div>
					</div>
				{/if}

				<div class="field-group">
					<label for="transport-criteria" class="field-label">{m.transport_criteriaLabel()}</label>
					<CriteriaInput bind:value={criteria} placeholder={m.transport_criteriaPlaceholder()} rows={2} />
					<p class="field-hint">{m.transport_criteriaHint()}</p>
				</div>

				{#if error && !areaInvalid}
					<p class="error-text" role="alert" transition:slide={{ duration: 150 }}>{error}</p>
				{/if}

				<StepButtons
					step1Disabled={isTesting}
					step1Loading={isTesting}
					step1Label={m.transport_testIds()}
					step1LoadingLabel={m.common_testing()}
					step2Enabled={testSuccess && testedConfigKey === configKey}
					onStep1={testFleet}
					onStep2={() => (showScheduleModal = true)}
				/>
			</FormPanel>
		</div>
		<div class="results-column">
			{#if isTesting || testSuccess || error}
				<ProgressIndicator
					progress={isTesting ? 55 : 100}
					message={m.transport_testingIds()}
					state={testSuccess ? 'success' : error ? 'error' : 'loading'}
					successMessage={m.transport_baselineReady()}
					successDetails={m.transport_baselineReadyHint({ count: String(baselineIds.length) })}
					errorTitle={m.transport_testFailed()}
					errorMessage={error}
					hintText={isTesting ? m.transport_testingIds() : ''}
					compact={testSuccess}
				/>
				{#if testSuccess && preview.length > 0}
					<div class="fleet-preview">
						{#each preview.slice(0, 3) as item}
							<span>{item.label || item.id}</span>
						{/each}
					</div>
				{/if}
			{/if}
		</div>
	</div>
</div>

<ScoutScheduleModal
	bind:open={showScheduleModal}
	scoutType="transport"
	scoutName=""
	transportMode={mode}
	transportConfig={builtConfig}
	transportAreaLabel={areaLbl}
	transportBaselineIds={baselineIds}
	onClose={() => (showScheduleModal = false)}
	onSuccess={() => {
		showScheduleModal = false;
		resetForm();
		onScheduled({ scoutType: 'transport' });
	}}
/>

<style>
	.field-group { margin-bottom: 1rem; }
	.field-label { display: block; font-size: 0.8125rem; font-weight: 500; color: var(--color-ink); margin-bottom: 0.5rem; }
	.field-hint { font-size: 0.75rem; color: var(--color-ink-subtle); margin: 0.375rem 0 0; line-height: 1.4; }
	.field-hint a { color: var(--color-primary); text-decoration: underline; }
	.req { color: var(--color-error); }
	.radius-row { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.5rem; }
	.radius-label { margin: 0; white-space: nowrap; }
	.radius-row .form-input { max-width: 10rem; }
	.chips { display: flex; flex-wrap: wrap; gap: 0.375rem; }
	.chip { padding: 0.3125rem 0.625rem; border: 1px solid var(--color-border); background: var(--color-surface); font-size: 0.75rem; cursor: pointer; color: var(--color-ink-muted); font-family: var(--font-body); }
	.chip.selected { border-color: var(--color-primary); background: var(--color-primary-soft); color: var(--color-primary-deep); }
	.error-text { margin: 0.5rem 0 0; padding: 0.5rem 0.75rem; background: color-mix(in oklab, var(--color-error) 10%, var(--color-card)); border: 1px solid color-mix(in oklab, var(--color-error) 32%, var(--color-border)); border-radius: var(--radius-md); color: var(--color-error); font-size: 0.8125rem; }
	.fleet-preview { margin-top: 0.75rem; display: grid; gap: 0.375rem; color: var(--color-ink-subtle); font-size: 0.75rem; }
	.fleet-preview span { padding: 0.375rem 0.5rem; background: color-mix(in oklab, var(--color-surface-alt) 68%, transparent); border-radius: var(--radius-sm); }
</style>

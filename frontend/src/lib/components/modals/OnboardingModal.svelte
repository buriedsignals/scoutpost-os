<script lang="ts">
	import { onMount } from 'svelte';
	import LocationAutocomplete from '$lib/components/ui/LocationAutocomplete.svelte';
	import { SUPPORTED_LANGUAGES, isSupported } from '$lib/i18n/constants';
	import * as m from '$lib/paraglide/messages';
	import type { GeocodedLocation } from '$lib/types';

	import { formatTz, getTimezoneOptions, normalizeTimezone } from '$lib/utils/timezones';

	export let open = false;
	export let saving = false;
	export let errorMessage: string | null = null;
	export let initialTimezone: string | null = null;
	export let onSave: (detail: { timezone: string; location: GeocodedLocation | null; preferred_language: string }) => void = () => {};

	let detectedTimezone: string | null = null;
	let selectedTimezone: string = initialTimezone ?? '';
	let selectedLocation: GeocodedLocation | null = null;

	function detectLanguage(): string {
		if (typeof navigator === 'undefined') return 'en';
		const browserLang = navigator.language?.slice(0, 2)?.toLowerCase() ?? '';
		return isSupported(browserLang) ? browserLang : 'en';
	}

	let selectedLanguage: string = detectLanguage();

	$: timezoneOptions = getTimezoneOptions(detectedTimezone);

	onMount(() => {
		try {
			const raw = Intl.DateTimeFormat().resolvedOptions().timeZone;
			detectedTimezone = raw ? normalizeTimezone(raw) : null;
			if (detectedTimezone && !selectedTimezone) {
				selectedTimezone = detectedTimezone;
			}
		} catch {
			// Ignore detection failure
		}
	});

	$: if (initialTimezone && !selectedTimezone) {
		selectedTimezone = initialTimezone;
	}

	function handleLocationSelect(location: GeocodedLocation) {
		selectedLocation = location;
	}

	function handleLocationClear() {
		selectedLocation = null;
	}

	function handleSubmit(event: Event) {
		event.preventDefault();
		if (!selectedTimezone) return;
		onSave({ timezone: selectedTimezone, location: selectedLocation, preferred_language: selectedLanguage });
	}
</script>

{#if open}
	<div
		class="fixed inset-0 bg-[var(--modal-backdrop)] backdrop-blur-sm flex items-center justify-center z-50 px-4"
	>
		<form
			class="w-full max-w-md border border-[color:var(--color-border)] bg-[color:var(--color-surface-alt)] text-[color:var(--color-ink)] rounded-2xl shadow-2xl p-6 space-y-5"
			on:submit|preventDefault={handleSubmit}
		>
			<div>
				<h2 class="text-2xl font-semibold text-[color:var(--color-ink)]">{m.onboarding_title()}</h2>
				<p class="text-[color:var(--color-ink-muted)] mt-1 text-sm">
					{m.onboarding_subtitle()}
				</p>
			</div>

			<div class="space-y-1">
				<label for="timezone-select" class="form-label">{m.onboarding_timezone()}</label>
				<p class="text-xs text-[color:var(--color-ink-muted)] mb-2">
					{m.onboarding_timezoneHint()}
				</p>
				{#if detectedTimezone}
					<p class="text-xs text-[color:var(--color-primary)] mb-2">
						{m.onboarding_detectedTimezone({ timezone: formatTz(detectedTimezone) })}
					</p>
				{/if}
				<select id="timezone-select" class="form-select" bind:value={selectedTimezone} required>
					<option value="" disabled>{m.onboarding_selectTimezone()}</option>
					{#each timezoneOptions as tz}
						<option value={tz}>{formatTz(tz)}</option>
					{/each}
				</select>
			</div>

			<div class="space-y-1">
				<label for="language-select" class="form-label">{m.onboarding_language()}</label>
				<p class="text-xs text-[color:var(--color-ink-muted)] mb-2">
					{m.onboarding_languageHint()}
				</p>
				<select id="language-select" class="form-select" bind:value={selectedLanguage} required>
					{#each SUPPORTED_LANGUAGES as lang}
						<option value={lang.code}>{lang.label}</option>
					{/each}
				</select>
			</div>

			<div class="space-y-1">
				<span class="form-label" id="location-label">{m.onboarding_location()} <span class="text-[color:var(--color-ink-subtle)]">{m.common_optional()}</span></span>
				<p class="text-xs text-[color:var(--color-ink-muted)] mb-2">
					{m.onboarding_locationHint()}
				</p>
				<LocationAutocomplete
					{selectedLocation}
					placeholder={m.onboarding_locationPlaceholder()}
					onSelect={handleLocationSelect}
					onClear={handleLocationClear}
				/>
			</div>

			{#if errorMessage}
				<p class="text-sm text-[color:var(--color-error)]">{errorMessage}</p>
			{/if}

			<button type="submit" class="btn-primary w-full" disabled={saving || !selectedTimezone}>
				{#if saving}
					<span class="flex items-center justify-center gap-2">
						<svg
							class="animate-spin h-4 w-4"
							xmlns="http://www.w3.org/2000/svg"
							fill="none"
							viewBox="0 0 24 24"
						>
							<circle
								class="opacity-25"
								cx="12"
								cy="12"
								r="10"
								stroke="currentColor"
								stroke-width="4"
							></circle>
							<path
								class="opacity-75"
								fill="currentColor"
								d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
							></path>
						</svg>
						{m.onboarding_preparing()}
					</span>
				{:else}
					{m.common_continue()}
				{/if}
			</button>
		</form>
	</div>
{/if}

<style>
	.form-label {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--color-ink-muted);
		margin-bottom: 0.75rem;
	}

</style>

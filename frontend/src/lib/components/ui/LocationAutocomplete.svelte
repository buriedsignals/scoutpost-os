<script lang="ts">
	import { onMount } from 'svelte';
	import { MapPin, X, Loader2, Clock, Globe } from 'lucide-svelte';
	import { env } from '$env/dynamic/public';
	import type { GeocodedLocation } from '$lib/types';
	import { getRecentLocations, addRecentLocation } from '$lib/stores/recent-locations';
	import * as m from '$lib/paraglide/messages';

	export let selectedLocation: GeocodedLocation | null = null;
	export let placeholder: string = 'Search for a city or country...';
	export let showGlobalOption: boolean = false;
	export let isGlobal: boolean = false;
	export let inputId: string | undefined = undefined;
	export let required: boolean = false;
	export let invalid: boolean = false;
	export let describedBy: string | undefined = undefined;
	export let onSelect: (location: GeocodedLocation) => void = () => {};
	export let onClear: () => void = () => {};
	export let onGlobal: () => void = () => {};

	let searchQuery = '';
	let suggestions: MapTilerFeature[] = [];
	let recentLocations: GeocodedLocation[] = [];
	let isLoading = false;
	let searchError = false;
	let showDropdown = false;
	let activeOptionIndex = -1;
	let debounceTimer: ReturnType<typeof setTimeout>;
	let inputElement: HTMLInputElement;

	interface MapTilerFeature {
		id: string;
		place_name: string;
		place_type: string[];
		text: string;
		context?: Array<{
			id: string;
			text: string;
			short_code?: string;
		}>;
		properties: {
			country_code?: string;
		};
		center?: [number, number]; // [lon, lat]
	}

	interface MapTilerResponse {
		features: MapTilerFeature[];
	}

	function debounce(fn: () => void, delay: number) {
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(fn, delay);
	}

	async function searchLocations(query: string) {
		if (!query || query.length < 2) {
			suggestions = [];
			showDropdown = false;
			searchError = false;
			activeOptionIndex = -1;
			return;
		}

		isLoading = true;
		showDropdown = true;
		searchError = false;

		try {
			const url = new URL(`https://api.maptiler.com/geocoding/${encodeURIComponent(query)}.json`);
			url.searchParams.set('key', env.PUBLIC_MAPTILER_API_KEY || '');
			url.searchParams.set('types', 'address,road,neighbourhood,postal_code,poi,major_landform');
			url.searchParams.set('excludeTypes', 'true');
			url.searchParams.set('limit', '5');

			const response = await fetch(url.toString());
			if (!response.ok) throw new Error('Geocoding request failed');

			const data: MapTilerResponse = await response.json();
			suggestions = data.features || [];
		} catch (error) {
			console.error('Geocoding error:', error);
			suggestions = [];
			searchError = true;
		} finally {
			isLoading = false;
		}
	}

	function handleInput() {
		activeOptionIndex = -1;
		debounce(() => searchLocations(searchQuery), 300);
	}

	function mapFeatureToLocation(feature: MapTilerFeature): GeocodedLocation {
		const placeType = feature.place_type[0];

		// Extract country code from properties or context
		let countryCode = feature.properties?.country_code?.toUpperCase() || '';

		// If not in properties, try to find in context
		if (!countryCode && feature.context) {
			const countryContext = feature.context.find((c) => c.id.startsWith('country'));
			if (countryContext?.short_code) {
				countryCode = countryContext.short_code.toUpperCase();
			}
		}

		// For country-level selections, use the feature's short_code
		if (placeType === 'country' && !countryCode) {
			// MapTiler uses lowercase country codes in the id like "country.ch"
			const idParts = feature.id.split('.');
			if (idParts.length > 1) {
				countryCode = idParts[1].toUpperCase();
			}
		}

		// Extract state/region code from context
		let stateCode: string | undefined;
		if (feature.context) {
			const regionContext = feature.context.find((c) => c.id.startsWith('region'));
			if (regionContext?.short_code) {
				// MapTiler returns state codes like "CH-ZH" - extract just the state part
				const shortCode = regionContext.short_code;
				stateCode = shortCode.includes('-') ? shortCode.split('-')[1] : shortCode;
			}
		}

		// Determine location type
		let locationType: 'city' | 'state' | 'country';
		let city: string | undefined;

		if (placeType === 'country') {
			locationType = 'country';
		} else if (placeType === 'region' || placeType === 'subregion') {
			locationType = 'state';
		} else {
			// municipality, county, locality, place, joint_municipality, etc.
			locationType = 'city';
			city = feature.text;
		}

		return {
			displayName: feature.place_name,
			city,
			state: stateCode,
			country: countryCode,
			locationType,
			maptilerId: feature.id,
			coordinates: feature.center ? {
				lon: feature.center[0],
				lat: feature.center[1]
			} : undefined
		};
	}

	function selectSuggestion(feature: MapTilerFeature) {
		const location = mapFeatureToLocation(feature);
		selectLocation(location);
	}

	function selectLocation(location: GeocodedLocation) {
		selectedLocation = location;
		searchQuery = '';
		suggestions = [];
		showDropdown = false;
		searchError = false;
		activeOptionIndex = -1;
		addRecentLocation(location);
		recentLocations = getRecentLocations();
		onSelect(location);
	}

	/**
	 * Filter recent locations by query (case-insensitive match on displayName).
	 */
	function getFilteredRecents(): GeocodedLocation[] {
		if (!searchQuery) return recentLocations;
		const query = searchQuery.toLowerCase();
		return recentLocations.filter((loc) => loc.displayName.toLowerCase().includes(query));
	}

	function clearLocation() {
		selectedLocation = null;
		searchQuery = '';
		suggestions = [];
		showDropdown = false;
		searchError = false;
		onClear();
	}

	function selectGlobal() {
		selectedLocation = null;
		searchQuery = '';
		suggestions = [];
		showDropdown = false;
		isGlobal = true;
		onGlobal();
	}

	function clearGlobal() {
		isGlobal = false;
		onClear();
	}

	function handleClickOutside(event: MouseEvent) {
		const target = event.target as Node;
		if (!inputElement?.parentElement?.contains(target)) {
			showDropdown = false;
		}
	}

	function handleFocus() {
		if (searchQuery.length >= 2 || filteredRecents.length > 0) {
			showDropdown = true;
		}
	}

	function retrySearch() {
		void searchLocations(searchQuery);
	}

	function selectOption(index: number) {
		if (index < filteredRecents.length) {
			selectLocation(filteredRecents[index]);
			return;
		}
		const suggestion = suggestions[index - filteredRecents.length];
		if (suggestion) selectSuggestion(suggestion);
	}

	function handleKeydown(event: KeyboardEvent) {
		const optionCount = filteredRecents.length + suggestions.length;
		if (event.key === 'Escape') {
			showDropdown = false;
			activeOptionIndex = -1;
			return;
		}
		if (optionCount === 0) return;
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			showDropdown = true;
			activeOptionIndex = (activeOptionIndex + 1 + optionCount) % optionCount;
		}
		if (event.key === 'ArrowUp') {
			event.preventDefault();
			showDropdown = true;
			activeOptionIndex = (activeOptionIndex - 1 + optionCount) % optionCount;
		}
		if (event.key === 'Enter' && activeOptionIndex >= 0) {
			event.preventDefault();
			selectOption(activeOptionIndex);
		}
	}

	export function focus() {
		inputElement?.focus();
	}

	// Reactive filtered recents based on search query
	$: filteredRecents = getFilteredRecents();
	$: listboxId = inputId ? `${inputId}-listbox` : 'location-autocomplete-listbox';

	onMount(() => {
		recentLocations = getRecentLocations();
		document.addEventListener('click', handleClickOutside);
		return () => {
			document.removeEventListener('click', handleClickOutside);
			clearTimeout(debounceTimer);
		};
	});
</script>

<div class="location-autocomplete">
	{#if selectedLocation}
		<!-- Selected location pill -->
		<button type="button" class="selected-location" on:click={clearLocation} title={m.locationAutocomplete_changeLocation()}>
			<MapPin size={14} />
			<span class="location-text">{selectedLocation.displayName}</span>
			<X size={14} class="remove-icon" />
		</button>
	{:else if showGlobalOption && isGlobal}
		<!-- Global pill -->
		<button type="button" class="selected-global" on:click={clearGlobal}>
			<Globe size={14} />
			<span class="location-text">Global</span>
			<X size={14} class="remove-icon" />
		</button>
	{:else}
		<!-- Search input -->
		<div class="search-container">
			<div class="input-wrapper">
				<MapPin size={14} class="input-icon" />
				<input
					bind:this={inputElement}
					id={inputId}
					type="text"
					bind:value={searchQuery}
					on:input={handleInput}
					on:focus={handleFocus}
					on:keydown={handleKeydown}
					role="combobox"
					aria-autocomplete="list"
					aria-controls={listboxId}
					aria-expanded={showDropdown}
					aria-activedescendant={activeOptionIndex >= 0 ? `${listboxId}-option-${activeOptionIndex}` : undefined}
					aria-invalid={invalid}
					aria-describedby={describedBy}
					aria-required={required}
					{placeholder}
					class="search-input {showGlobalOption ? 'has-global-btn' : ''}"
				/>
				{#if isLoading}
					<Loader2 size={14} class="loading-icon" />
				{/if}
				{#if showGlobalOption && !isLoading}
					<button type="button" class="global-btn" on:click={selectGlobal}>
						<Globe size={12} />
						Global
					</button>
				{/if}
			</div>

			{#if showDropdown && (suggestions.length > 0 || isLoading || filteredRecents.length > 0 || searchError || searchQuery.length >= 2)}
				<div id={listboxId} class="suggestions-dropdown" role="listbox">
					{#if filteredRecents.length > 0}
						<div class="section-label">{m.locationAutocomplete_recent()}</div>
						{#each filteredRecents as recent, i (recent.maptilerId)}
							<button
								type="button"
								class="suggestion-item"
								class:active={activeOptionIndex === i}
								id={`${listboxId}-option-${i}`}
								role="option"
								aria-selected={activeOptionIndex === i}
								on:click={() => selectLocation(recent)}
							>
								<Clock size={14} />
								<span>{recent.displayName}</span>
							</button>
						{/each}
						{#if suggestions.length > 0 || isLoading}
							<div class="section-divider"></div>
						{/if}
					{/if}
					{#if isLoading && suggestions.length === 0}
						<div class="suggestion-loading">{m.locationAutocomplete_searching()}</div>
					{:else if suggestions.length > 0}
						{#each suggestions as suggestion, i (suggestion.id)}
							<button
								type="button"
								class="suggestion-item"
								class:active={activeOptionIndex === filteredRecents.length + i}
								id={`${listboxId}-option-${filteredRecents.length + i}`}
								role="option"
								aria-selected={activeOptionIndex === filteredRecents.length + i}
								on:click={() => selectSuggestion(suggestion)}
							>
								<MapPin size={14} />
								<span>{suggestion.place_name}</span>
							</button>
						{/each}
					{:else if searchError}
						<div class="suggestion-empty" role="status">
							{m.locationAutocomplete_searchFailed()}
							<button type="button" class="retry-btn" on:click={retrySearch}>{m.locationAutocomplete_retry()}</button>
						</div>
					{:else if searchQuery.length >= 2 && filteredRecents.length === 0}
						<div class="suggestion-empty">{m.locationAutocomplete_noLocations()}</div>
					{/if}
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.location-autocomplete {
		width: 100%;
	}

	.selected-location {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.625rem 0.75rem;
		background: var(--color-primary-soft);
		border: 1px solid var(--color-primary);
		border-radius: 0;
		font-size: 0.8125rem;
		font-weight: 500;
		font-family: var(--font-body);
		color: var(--color-ink);
		cursor: pointer;
		transition: all 0.2s ease;
		text-align: left;
	}

	.selected-location:hover {
		background: color-mix(in srgb, var(--color-primary-soft) 70%, var(--color-surface-alt));
		border-color: var(--color-primary-deep);
	}

	.selected-global {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.625rem 0.75rem;
		background: var(--color-surface-alt);
		border: 1px solid var(--color-border);
		border-radius: 0;
		font-size: 0.8125rem;
		font-weight: 500;
		font-family: var(--font-body);
		color: var(--color-ink-muted);
		cursor: pointer;
		transition: all 0.2s ease;
		text-align: left;
	}

	.selected-global:hover {
		background: var(--color-bg);
		border-color: var(--color-border-strong);
	}

	.selected-global :global(.remove-icon) {
		opacity: 0.5;
		transition: opacity 0.2s ease;
		flex-shrink: 0;
	}

	.selected-global:hover :global(.remove-icon) {
		opacity: 1;
		color: var(--color-error);
	}

	.location-text {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.selected-location :global(.remove-icon) {
		opacity: 0.5;
		transition: opacity 0.2s ease;
		flex-shrink: 0;
	}

	.selected-location:hover :global(.remove-icon) {
		opacity: 1;
		color: var(--color-error);
	}

	.search-container {
		position: relative;
	}

	.input-wrapper {
		position: relative;
		display: flex;
		align-items: center;
	}

	.input-wrapper :global(.input-icon) {
		position: absolute;
		left: 0.75rem;
		color: var(--color-primary);
		pointer-events: none;
	}

	.search-input {
		width: 100%;
		padding: 0.625rem 0.75rem 0.625rem 2.25rem;
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: 0;
		font-size: 0.8125rem;
		font-family: var(--font-body);
		color: var(--color-ink);
		transition: all 0.2s ease;
	}

	.search-input:focus {
		outline: none;
		border-color: var(--color-primary);
		background: var(--color-surface-alt);
		box-shadow: 0 0 0 3px var(--color-primary-soft);
	}

	.search-input[aria-invalid='true'] {
		border-color: var(--color-error);
	}

	.suggestion-item.active {
		background: var(--color-primary-soft);
		color: var(--color-primary-deep);
	}

	.retry-btn {
		margin-left: 0.5rem;
		border: 0;
		background: transparent;
		color: var(--color-primary);
		font: inherit;
		text-decoration: underline;
		cursor: pointer;
	}

	.search-input::placeholder {
		color: var(--color-ink-subtle);
	}

	.search-input.has-global-btn {
		padding-right: 5.5rem;
	}

	.global-btn {
		position: absolute;
		right: 0.375rem;
		display: flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.3rem 0.5rem;
		background: var(--color-surface-alt);
		border: 1px solid var(--color-border);
		border-radius: 0;
		font-size: 0.6875rem;
		font-weight: 500;
		font-family: var(--font-body);
		color: var(--color-ink-muted);
		cursor: pointer;
		transition: all 0.15s ease;
		white-space: nowrap;
	}

	.global-btn:hover {
		background: var(--color-bg);
		border-color: var(--color-border-strong);
		color: var(--color-ink);
	}

	.input-wrapper :global(.loading-icon) {
		position: absolute;
		right: 0.75rem;
		color: var(--color-primary);
		animation: spin 1s linear infinite;
	}

	@keyframes spin {
		from {
			transform: rotate(0deg);
		}
		to {
			transform: rotate(360deg);
		}
	}

	.suggestions-dropdown {
		position: absolute;
		top: calc(100% + 0.25rem);
		left: 0;
		right: 0;
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		padding: 0.5rem;
		background: var(--color-surface-alt);
		border: 1px solid var(--color-border);
		border-radius: 0;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
		z-index: 50;
		max-height: 240px;
		overflow-y: auto;
	}

	.suggestion-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.625rem 0.75rem;
		border-radius: 0;
		font-size: 0.8125rem;
		font-family: var(--font-body);
		color: var(--color-ink);
		background: transparent;
		border: none;
		text-align: left;
		cursor: pointer;
		transition: background 0.15s ease;
	}

	.suggestion-item:hover {
		background: var(--color-bg);
	}

	.suggestion-item :global(svg) {
		color: var(--color-ink-subtle);
		flex-shrink: 0;
	}

	.suggestion-loading,
	.suggestion-empty {
		padding: 0.75rem;
		text-align: center;
		font-size: 0.75rem;
		color: var(--color-ink-muted);
		font-style: italic;
	}

	.section-label {
		padding: 0.375rem 0.75rem 0.25rem;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		color: var(--color-ink-subtle);
		text-transform: uppercase;
		letter-spacing: 0.1em;
	}

	.section-divider {
		height: 1px;
		background: var(--color-border);
		margin: 0.375rem 0.5rem;
	}
</style>

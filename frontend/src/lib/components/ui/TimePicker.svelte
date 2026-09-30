<script lang="ts">
	import { Clock } from 'lucide-svelte';
	import * as m from '$lib/paraglide/messages';

	export let hour = 12;
	export let minute = 0;
	export let period: 'AM' | 'PM' = 'PM';
	export let timezoneLabel: string = m.schedule_localTime();
	export let showLabel = true;

</script>

<div class="time-picker">
	{#if showLabel}
		<label class="form-label time-label">
			<Clock size={14} class="time-label-icon" />
			<span>{m.timePicker_label({ timezone: timezoneLabel })}</span>
		</label>
	{/if}

	<div class="time-row">
		<!-- Hour Select -->
		<select bind:value={hour} class="form-select time-slot">
			<option value={12}>12</option>
			{#each Array.from({ length: 11 }, (_, i) => i + 1) as h}
				<option value={h}>{h}</option>
			{/each}
		</select>

		<span class="time-sep">:</span>

		<!-- Minute Select -->
		<select bind:value={minute} class="form-select time-slot">
			<option value={0}>00</option>
			<option value={15}>15</option>
			<option value={30}>30</option>
			<option value={45}>45</option>
		</select>

		<!-- Period Select -->
		<select bind:value={period} class="form-select time-slot">
			<option value="AM">{m.timePicker_am()}</option>
			<option value="PM">{m.timePicker_pm()}</option>
		</select>
	</div>
</div>

<style>
	.time-picker {
		margin-bottom: 1.25rem;
	}

	.time-picker:last-child {
		margin-bottom: 0;
	}

	.time-label {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
	}

	.time-label :global(.time-label-icon) {
		color: var(--color-ink-subtle);
		flex-shrink: 0;
	}

	.time-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.time-sep {
		color: var(--color-ink-muted);
		font-weight: 500;
	}

	.time-slot {
		flex: 1;
	}
</style>

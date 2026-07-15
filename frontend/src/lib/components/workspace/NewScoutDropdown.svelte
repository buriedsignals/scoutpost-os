<script lang="ts">
	import { goto } from '$app/navigation';
	import { browser } from '$app/environment';
	import { ChevronDown, Crosshair, Landmark, Plus, Radar, ShipWheel, Users } from 'lucide-svelte';
	import { authStore } from '$lib/stores/auth';
	import { isHostedScoutpostHost } from '$lib/utils/agent-targets';
	import { isFleetScoutLocked } from '$lib/utils/fleet-entitlement';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import * as m from '$lib/paraglide/messages';

	export let onSelect: (type: 'web' | 'pulse' | 'social' | 'civic' | 'transport') => void = () => {};

	$: isPro = ($authStore.user?.tier ?? 'free') !== 'free';
	$: fleetLocked = isFleetScoutLocked({
		isHosted: browser && isHostedScoutpostHost(window.location.hostname),
		authenticated: $authStore.authenticated,
		tier: $authStore.user?.tier
	});

	function select(type: 'web' | 'pulse' | 'social' | 'civic' | 'transport') {
		onSelect(type);
	}

	function handleCivicScout() {
		if (!isPro) {
			return; // unlimited in self-hosted
			return;
		}
		select('civic');
	}

	function handleTransportScout() {
		if (fleetLocked) {
			return; // unlimited in self-hosted
			return;
		}
		select('transport');
	}
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				class="new-scout-trigger h-8 cursor-pointer rounded-xl bg-primary px-3.5 font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-primary-foreground shadow-[0_8px_22px_oklch(0.1_0.02_75/0.2)] transition-[transform,background-color,box-shadow] duration-200 hover:-translate-y-px hover:bg-primary/90 hover:shadow-[0_11px_26px_oklch(0.1_0.02_75/0.27)]"
				aria-label="New Scout"
			>
				<Plus size={14} strokeWidth={2.5} />
				<span>New Scout</span>
				<ChevronDown size={11} strokeWidth={2.5} />
			</Button>
		{/snippet}
	</DropdownMenu.Trigger>

	<DropdownMenu.Content
		align="start"
		sideOffset={8}
		class="w-[300px] rounded-xl border-border bg-popover p-1.5 text-popover-foreground shadow-[0_22px_54px_oklch(0.06_0.015_210/0.58)]"
	>
		<DropdownMenu.Item class="scout-option" onSelect={() => select('web')}>
			<span class="option-icon"><Crosshair size={20} /></span>
			<span class="option-content">
				<strong>{m.newScout_trackTitle()}</strong>
				<small>{m.newScout_trackDescription()}</small>
			</span>
		</DropdownMenu.Item>
		<DropdownMenu.Separator class="mx-3" />

		<DropdownMenu.Item class={`scout-option scout-option--pro${fleetLocked ? ' scout-option--locked' : ''}`} onSelect={handleTransportScout}>
			<span class="option-icon"><ShipWheel size={20} /></span>
			<span class="option-content">
				<strong>{m.transport_trackTitle()}{#if fleetLocked}<span class="pro-badge">PRO</span>{/if}</strong>
				<small>{m.newScout_fleetDescription()}</small>
			</span>
		</DropdownMenu.Item>
		<DropdownMenu.Separator class="mx-3" />

		<DropdownMenu.Item class="scout-option" onSelect={() => select('social')}>
			<span class="option-icon"><Users size={20} /></span>
			<span class="option-content">
				<strong>{m.newScout_profileTitle()}</strong>
				<small>{m.newScout_profileDescription()}</small>
			</span>
		</DropdownMenu.Item>
		<DropdownMenu.Separator class="mx-3" />

		<DropdownMenu.Item class="scout-option" onSelect={() => select('pulse')}>
			<span class="option-icon"><Radar size={20} /></span>
			<span class="option-content">
				<strong>{m.newScout_beatScoutTitle()}</strong>
				<small>{m.newScout_beatScoutDescription()}</small>
			</span>
		</DropdownMenu.Item>
		<DropdownMenu.Separator class="mx-3" />

		<DropdownMenu.Item class={`scout-option scout-option--pro${isPro ? '' : ' scout-option--locked'}`} onSelect={handleCivicScout}>
			<span class="option-icon"><Landmark size={20} /></span>
			<span class="option-content">
				<strong>{m.civic_trackCouncil()}{#if !isPro}<span class="pro-badge">PRO</span>{/if}</strong>
				<small>{m.civic_monitorDescription()}</small>
			</span>
		</DropdownMenu.Item>
	</DropdownMenu.Content>
</DropdownMenu.Root>

<style>
	:global(.scout-option) {
		align-items: flex-start;
		gap: 0.75rem;
		padding: 0.75rem;
		border-radius: var(--radius-md);
		transition: background 150ms ease, color 150ms ease;
	}

	:global(.scout-option:focus) {
		background: var(--accent);
		color: var(--accent-foreground);
	}

	.option-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		flex-shrink: 0;
		border-radius: var(--radius-md);
		background: var(--muted);
		color: var(--muted-foreground);
		transition: background 150ms ease, color 150ms ease;
	}

	:global(.scout-option:focus) .option-icon {
		background: oklch(0.87 0.025 205 / 12%);
		color: var(--foreground);
	}

	.option-content {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 0.1875rem;
	}

	.option-content strong {
		display: inline-flex;
		align-items: center;
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--foreground);
	}

	.option-content small {
		font-size: 0.75rem;
		font-weight: 500;
		line-height: 1.45;
		color: var(--muted-foreground);
	}

	:global(.scout-option--locked) {
		opacity: 0.58;
	}

	.pro-badge {
		display: inline-block;
		margin-left: 0.4375rem;
		padding: 0.125rem 0.4375rem;
		border-radius: var(--radius-pill);
		background: var(--primary);
		color: var(--primary-foreground);
		font-family: var(--font-mono);
		font-size: 0.5625rem;
		font-weight: 600;
		letter-spacing: 0.1em;
	}
</style>

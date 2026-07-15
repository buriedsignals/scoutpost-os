<script lang="ts">
	import { goto } from '$app/navigation';
	import { browser } from '$app/environment';
	import { Crosshair, Radar, Users, Landmark, ShipWheel } from 'lucide-svelte';
	import { authStore } from '$lib/stores/auth';
	import { isHostedScoutpostHost } from '$lib/utils/agent-targets';
	import { isFleetScoutLocked } from '$lib/utils/fleet-entitlement';
	import * as m from '$lib/paraglide/messages';

	export let open = false;
	export let sidebarCollapsed = false;
	export let onSelect: (type: 'web' | 'pulse' | 'social' | 'civic' | 'transport') => void = () => {};
	export let onClose: () => void = () => {};

	$: isPro = ($authStore.user?.tier ?? 'free') !== 'free';
	$: fleetLocked = isFleetScoutLocked({
		isHosted: browser && isHostedScoutpostHost(window.location.hostname),
		authenticated: $authStore.authenticated,
		tier: $authStore.user?.tier
	});

	function handleTrackPage() {
		onSelect('web');
		onClose();
	}

	function handleBeatScout() {
		onSelect('pulse');
		onClose();
	}

	function handleProfileScout() {
		onSelect('social');
		onClose();
	}

	function handleCivicScout() {
		if (!isPro) {
			onClose();
			return; // unlimited in self-hosted
			return;
		}
		onSelect('civic');
		onClose();
	}

	function handleTransportScout() {
		if (fleetLocked) {
			onClose();
			return; // unlimited in self-hosted
			return;
		}
		onSelect('transport');
		onClose();
	}

	function handleClickOutside(event: MouseEvent) {
		const target = event.target as HTMLElement;
		if (!target.closest('.new-scout-dropdown')) {
			onClose();
		}
	}
</script>

{#if open}
	<!-- svelte-ignore a11y-click-events-have-key-events -->
	<!-- svelte-ignore a11y-no-static-element-interactions -->
	<div class="dropdown-backdrop" on:click={handleClickOutside}>
		<div class="new-scout-dropdown" style:left={sidebarCollapsed ? '56px' : '228px'}>
			<button class="scout-option" on:click={handleTrackPage}>
				<div class="option-icon">
					<Crosshair size={20} />
				</div>
				<div class="option-content">
					<span class="option-title">{m.newScout_trackTitle()}</span>
					<span class="option-description">{m.newScout_trackDescription()}</span>
				</div>
			</button>

			<div class="option-divider"></div>

			<button class="scout-option scout-option--civic" class:scout-option--locked={fleetLocked} on:click={handleTransportScout}>
				<div class="option-icon option-icon--civic" class:option-icon--locked={fleetLocked}>
					<ShipWheel size={20} />
				</div>
				<div class="option-content">
					<span class="option-title">
						{m.transport_trackTitle()}
						{#if fleetLocked}
							<span class="pro-badge">PRO</span>
						{/if}
					</span>
					<span class="option-description">{m.newScout_fleetDescription()}</span>
				</div>
			</button>

			<div class="option-divider"></div>

			<button class="scout-option" on:click={handleProfileScout}>
				<div class="option-icon">
					<Users size={20} />
				</div>
				<div class="option-content">
					<span class="option-title">{m.newScout_profileTitle()}</span>
					<span class="option-description">{m.newScout_profileDescription()}</span>
				</div>
			</button>

			<div class="option-divider"></div>

			<button class="scout-option" on:click={handleBeatScout}>
				<div class="option-icon">
					<Radar size={20} />
				</div>
				<div class="option-content">
					<span class="option-title">{m.newScout_beatScoutTitle()}</span>
					<span class="option-description">{m.newScout_beatScoutDescription()}</span>
				</div>
			</button>

			<div class="option-divider"></div>

			<button class="scout-option scout-option--civic" class:scout-option--locked={!isPro} on:click={handleCivicScout}>
				<div class="option-icon option-icon--civic" class:option-icon--locked={!isPro}>
					<Landmark size={20} />
				</div>
				<div class="option-content">
					<span class="option-title">
						{m.civic_trackCouncil()}
						{#if !isPro}
							<span class="pro-badge">PRO</span>
						{/if}
					</span>
					<span class="option-description">{m.civic_monitorDescription()}</span>
				</div>
			</button>
		</div>
	</div>
{/if}

<style>
	.dropdown-backdrop {
		position: fixed;
		inset: 0;
		z-index: 50;
		cursor: pointer;
	}

	.new-scout-dropdown {
		position: absolute;
		left: 228px;
		top: 60px;
		width: 300px;
		background: var(--color-surface-alt);
		border: 1px solid var(--color-border);
		box-shadow: var(--shadow-modal);
		padding: 0.375rem;
		animation: slideIn 150ms cubic-bezier(0.4, 0, 0.2, 1);
		font-family: var(--font-body);
	}

	@keyframes slideIn {
		from { opacity: 0; transform: translateX(-6px); }
		to   { opacity: 1; transform: translateX(0); }
	}

	.scout-option {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		width: 100%;
		padding: 0.75rem;
		border: 1px solid transparent;
		background: transparent;
		cursor: pointer;
		transition: background 150ms ease, border-color 150ms ease;
		text-align: left;
	}

	.scout-option:hover {
		background: var(--color-primary-soft);
		border-color: var(--color-primary);
	}

	.scout-option--civic:hover {
		background: var(--color-secondary-soft);
		border-color: var(--color-secondary);
	}

	.option-icon {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		background: var(--color-surface);
		color: var(--color-ink-muted);
		border: 1px solid var(--color-border);
		transition: background 150ms ease, color 150ms ease, border-color 150ms ease;
	}

	.scout-option:hover .option-icon {
		background: var(--color-bg);
		color: var(--color-primary);
		border-color: var(--color-primary);
	}

	.scout-option--civic:hover .option-icon--civic {
		background: var(--color-bg);
		color: var(--color-secondary);
		border-color: var(--color-secondary);
	}

	.option-content {
		display: flex;
		flex-direction: column;
		gap: 0.1875rem;
		min-width: 0;
	}

	.option-title {
		display: inline-flex;
		align-items: center;
		font-family: var(--font-body);
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--color-ink);
	}

	.option-description {
		font-size: 0.75rem;
		font-weight: 300;
		color: var(--color-ink-muted);
		line-height: 1.45;
	}

	.option-divider {
		height: 1px;
		background: var(--color-border);
		margin: 0.25rem 0.75rem;
	}

	.scout-option--locked {
		opacity: 0.55;
	}

	.scout-option--locked:hover {
		background: var(--color-surface);
		border-color: var(--color-border);
	}

	.option-icon--locked {
		background: var(--color-surface);
		color: var(--color-ink-subtle);
	}

	.scout-option--locked:hover .option-icon--locked {
		background: var(--color-surface);
		color: var(--color-ink-subtle);
		border-color: var(--color-border);
	}

	.pro-badge {
		display: inline-block;
		font-family: var(--font-mono);
		font-size: 0.5625rem;
		font-weight: 500;
		letter-spacing: 0.1em;
		padding: 0.125rem 0.4375rem;
		background: var(--color-secondary);
		color: var(--color-bg);
		vertical-align: middle;
		margin-left: 0.4375rem;
	}
</style>

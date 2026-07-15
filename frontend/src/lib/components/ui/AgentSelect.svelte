<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { ChevronDown } from 'lucide-svelte';
	import { AGENTS, type AgentSlug } from '$lib/utils/agent-icons';

	export let value: AgentSlug = 'claude-code';
	export let onChange: (value: AgentSlug) => void = () => {};

	let open = false;
	let wrap: HTMLDivElement;
	let menu: HTMLUListElement;
	let canScrollUp = false;
	let canScrollDown = false;

	$: current = AGENTS.find((a) => a.slug === value) ?? AGENTS[0];

	function updateScrollIndicators() {
		if (!menu) {
			canScrollUp = false;
			canScrollDown = false;
			return;
		}
		canScrollUp = menu.scrollTop > 2;
		canScrollDown = menu.scrollTop + menu.clientHeight < menu.scrollHeight - 2;
	}

	function closeMenu() {
		open = false;
		canScrollUp = false;
		canScrollDown = false;
	}

	async function toggleMenu() {
		open = !open;
		if (open) {
			await tick();
			updateScrollIndicators();
		}
	}

	function pick(slug: AgentSlug) {
		closeMenu();
		if (slug !== value) {
			value = slug;
			onChange(slug);
		}
	}

	function onDocClick(e: MouseEvent) {
		if (!open) return;
		if (wrap && !wrap.contains(e.target as Node)) closeMenu();
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') closeMenu();
	}

	onMount(() => {
		document.addEventListener('click', onDocClick);
		document.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('click', onDocClick);
			document.removeEventListener('keydown', onKey);
		};
	});
</script>

<div class="agent-select" bind:this={wrap}>
	<button
		type="button"
		class="trigger"
		on:click|stopPropagation={toggleMenu}
		aria-haspopup="listbox"
		aria-expanded={open}
	>
		<span class="label">Agent</span>
		<span class="current">
			<svg
				class="icon"
				viewBox="0 0 24 24"
				width="14"
				height="14"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"
			>
				{@html current.iconInner}
			</svg>
			<span class="name">{current.name}</span>
		</span>
		<ChevronDown size={14} class="chev" />
	</button>

	{#if open}
		<div class="menu-wrap" class:scroll-up={canScrollUp} class:scroll-down={canScrollDown}>
			<ul class="menu" role="listbox" bind:this={menu} on:scroll={updateScrollIndicators}>
				{#each AGENTS as a (a.slug)}
					<li>
						<button
							type="button"
							class="item"
							class:selected={a.slug === value}
							role="option"
							aria-selected={a.slug === value}
							on:click|stopPropagation={() => pick(a.slug)}
						>
							<svg
								class="icon"
								viewBox="0 0 24 24"
								width="14"
								height="14"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
								aria-hidden="true"
							>
								{@html a.iconInner}
							</svg>
							<span class="name">{a.name}</span>
						</button>
					</li>
				{/each}
			</ul>
		</div>
	{/if}
</div>

<style>
	.agent-select {
		position: relative;
		display: inline-block;
	}

	.trigger {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.75rem 0.5rem 0.625rem;
		background: var(--color-surface-alt);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		font-size: 0.875rem;
		color: var(--color-ink);
		cursor: pointer;
		transition:
			border-color 0.15s ease,
			box-shadow 0.15s ease;
		min-width: 14rem;
	}
	.trigger:hover {
		border-color: var(--color-border-strong);
	}
	.trigger[aria-expanded='true'] {
		border-color: var(--ring);
		box-shadow: 0 0 0 3px oklch(0.78 0.045 205 / 12%);
	}

	.label {
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--color-ink-muted);
		text-transform: uppercase;
		letter-spacing: 0.06em;
		padding-right: 0.125rem;
	}

	.current {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		flex: 1;
		min-width: 0;
	}

	.current .name {
		font-weight: 600;
		color: var(--color-ink);
	}

	:global(.agent-select .chev) {
		margin-left: auto;
		color: var(--color-ink-subtle);
	}

	.menu-wrap {
		position: absolute;
		left: 0;
		top: calc(100% + 4px);
		z-index: 50;
		min-width: 100%;
		background: var(--color-surface-alt);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-lg);
		max-height: min(34rem, calc(100vh - 8rem));
		overflow: hidden;
	}

	.menu-wrap::before,
	.menu-wrap::after {
		content: '';
		position: absolute;
		left: 0;
		right: 0;
		z-index: 2;
		height: 1.75rem;
		pointer-events: none;
		opacity: 0;
		transition: opacity 0.12s ease;
	}

	.menu-wrap::before {
		top: 0;
		background: linear-gradient(to bottom, var(--color-surface-alt), transparent);
		box-shadow: inset 0 10px 10px -12px oklch(0.06 0.015 210 / 55%);
	}

	.menu-wrap::after {
		bottom: 0;
		background: linear-gradient(to top, var(--color-surface-alt), transparent);
		box-shadow: inset 0 -12px 12px -14px oklch(0.06 0.015 210 / 55%);
	}

	.menu-wrap.scroll-up::before,
	.menu-wrap.scroll-down::after {
		opacity: 1;
	}

	.menu {
		position: relative;
		max-height: min(34rem, calc(100vh - 8rem));
		overflow-y: auto;
		margin: 0;
		padding: 0.25rem;
		list-style: none;
		scrollbar-gutter: stable;
	}

	.item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.5rem 0.625rem;
		background: transparent;
		border: none;
		border-radius: var(--radius-md);
		font-size: 0.875rem;
		color: var(--color-ink);
		cursor: pointer;
		text-align: left;
	}

	.item:hover {
		background: var(--color-secondary-soft);
		color: var(--color-ink);
	}

	.item.selected {
		background: oklch(0.48 0.035 205 / 32%);
		color: oklch(0.87 0.025 205);
		font-weight: 600;
	}

	.icon {
		flex-shrink: 0;
	}
</style>

<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { ChevronLeft } from 'lucide-svelte';
	import BeatScoutView from '$lib/components/news/BeatScoutView.svelte';
	import PageScoutView from '$lib/components/news/PageScoutView.svelte';
	import SocialScoutView from '$lib/components/news/SocialScoutView.svelte';
	import CivicScoutView from '$lib/components/news/CivicScoutView.svelte';

	const VALID = ['pulse', 'web', 'social', 'civic'] as const;
	type ValidType = (typeof VALID)[number];

	const LABELS: Record<ValidType, string> = {
		pulse: 'Beat Monitor',
		web: 'Page Monitor',
		social: 'Social Monitor',
		civic: 'Civic Monitor'
	};

	function isValid(value: string | undefined): value is ValidType {
		return !!value && (VALID as readonly string[]).includes(value);
	}

	$: rawType = $page.params.type;
	$: type = isValid(rawType) ? rawType : null;

	onMount(() => {
		if (!isValid(rawType)) {
			goto('/', { replaceState: true });
		}
	});
</script>

<div class="wrapper">
	<div class="topbar">
		<a class="back" href="/">
			<ChevronLeft size={14} />
			<span>Back</span>
		</a>
		{#if type}
			<h1 class="title">New {LABELS[type]} scout</h1>
		{/if}
	</div>

	{#if type}
		<div class="panel-slot">
			{#if type === 'pulse'}
				<BeatScoutView initialMode="beat" />
			{:else if type === 'web'}
				<PageScoutView />
			{:else if type === 'social'}
				<SocialScoutView />
			{:else if type === 'civic'}
				<CivicScoutView />
			{/if}
		</div>
	{/if}
</div>

<style>
	.wrapper {
		display: flex;
		flex-direction: column;
		min-height: 100vh;
		background: var(--color-bg);
		font-family: var(--font-body);
	}

	.topbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 1.5rem 2rem;
		border-bottom: 1px solid var(--color-border);
		background: var(--color-surface-alt);
	}

	.back {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--color-ink-muted);
		text-decoration: none;
		padding: 0.4375rem 0.75rem;
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		transition: border-color 150ms ease, color 150ms ease;
	}

	.back:hover {
		color: var(--color-primary);
		border-color: var(--color-primary);
	}

	.title {
		font-family: var(--font-display);
		font-size: 1.375rem;
		font-weight: 600;
		color: var(--color-ink);
		margin: 0;
		letter-spacing: -0.01em;
	}

	.panel-slot {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
	}
</style>

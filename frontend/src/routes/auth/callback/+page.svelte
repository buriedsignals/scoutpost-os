<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { browser } from '$app/environment';
	import Spinner from '$lib/components/ui/Spinner.svelte';
	import { consumeAuthReturn } from '$lib/utils/auth-return';

	let status: 'loading' | 'error' = 'loading';
	let errorMessage = '';

	onMount(async () => {
		if (!browser) return;

		const hash = window.location.hash.slice(1); // drop the leading '#'
		const params = new URLSearchParams(hash);
		const access_token = params.get('access_token');
		const refresh_token = params.get('refresh_token');

		if (!access_token || !refresh_token) {
			status = 'error';
			errorMessage = 'Missing session tokens. Please try signing in again.';
			return;
		}

		try {
			const { createClient } = await import('@supabase/supabase-js');
			const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL;
			const supabaseKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;
			const supabase = createClient(supabaseUrl, supabaseKey);

			const { error } = await supabase.auth.setSession({ access_token, refresh_token });
			if (error) {
				status = 'error';
				errorMessage = error.message || 'Could not establish session.';
				return;
			}
		} catch (e: any) {
			status = 'error';
			errorMessage = e?.message || 'Could not establish session.';
			return;
		}

		// Strip tokens from visible URL before navigating
		const destination = consumeAuthReturn();
		history.replaceState({}, '', destination);
		await goto(destination);
	});
</script>

<div class="callback-container">
	{#if status === 'loading'}
		<div class="callback-card callback-card--loading" aria-label="Signing in">
			<Spinner size="lg" />
		</div>
	{:else}
		<div class="callback-card callback-card--error">
			<h1 class="callback-heading">Login failed</h1>
			<p class="callback-message">{errorMessage}</p>
			<a href="/login" class="callback-link">Try again</a>
		</div>
	{/if}
</div>

<style>
	.callback-container {
		min-height: 100vh;
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--color-bg);
		color: var(--color-ink);
		padding: 1.5rem;
	}

	.callback-card {
		max-width: 24rem;
		text-align: center;
		display: flex;
		flex-direction: column;
		gap: 1rem;
		padding: 1.5rem;
	}

	.callback-card--loading {
		align-items: center;
		justify-content: center;
		min-height: 8rem;
	}

	.callback-heading {
		font-family: var(--font-display, inherit);
		font-size: 1.25rem;
		font-weight: 600;
		color: var(--color-ink);
		margin: 0;
	}

	.callback-message {
		font-size: 0.875rem;
		color: var(--color-ink-muted);
		margin: 0;
	}

	.callback-link {
		color: var(--color-primary);
		text-decoration: underline;
		font-size: 0.875rem;
	}

	.callback-link:hover {
		color: var(--color-primary-deep);
	}
</style>

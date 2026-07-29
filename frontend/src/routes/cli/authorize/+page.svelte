<script lang="ts">
	import { page } from '$app/stores';
	import { auth, authStore } from '$lib/stores/auth';
	import { apiClient, type CliAuthorizationRequest } from '$lib/api-client';
	import { rememberAuthReturn } from '$lib/utils/auth-return';

	let request: CliAuthorizationRequest | null = null;
	let loading = false;
	let loadedCode: string | null = null;
	let action: 'approve' | 'deny' | null = null;
	let completed: 'approved' | 'denied' | null = null;
	let error = '';
	let observedUserCode: string | null = null;
	let lookupVersion = 0;

	$: userCode = ($page.url.searchParams.get('user_code') ?? '').toUpperCase();
	$: validCode = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(userCode);
	$: if (userCode !== observedUserCode) {
		observedUserCode = userCode;
		lookupVersion += 1;
		request = null;
		loading = false;
		loadedCode = null;
		action = null;
		completed = null;
		error = '';
	}
	$: if ($authStore.authenticated && validCode && loadedCode !== userCode) {
		void loadRequest(userCode);
	}

	async function loadRequest(code: string) {
		const version = ++lookupVersion;
		loadedCode = code;
		loading = true;
		error = '';
		try {
			const loaded = await apiClient.getCliAuthorizationRequest(code);
			if (version !== lookupVersion || code !== userCode) return;
			if (loaded.user_code !== code) {
				request = null;
				error = 'This authorization request does not match the code in this page.';
				return;
			}
			request = loaded;
		} catch (caught) {
			if (version !== lookupVersion || code !== userCode) return;
			error = caught instanceof Error ? caught.message : 'Could not load this request.';
		} finally {
			if (version === lookupVersion && code === userCode) loading = false;
		}
	}

	function signIn() {
		if (!rememberAuthReturn(`/cli/authorize?user_code=${encodeURIComponent(userCode)}`)) {
			error = 'Your browser could not preserve this request. Enable session storage and try again.';
			return;
		}
		auth.login();
	}

	async function decide(decision: 'approve' | 'deny') {
		if (!request || request.status !== 'pending' || request.user_code !== userCode) {
			if (request && request.user_code !== userCode) {
				error = 'This authorization request does not match the code in this page.';
			}
			return;
		}
		const requestCode = request.user_code;
		const version = lookupVersion;
		action = decision;
		error = '';
		try {
			await apiClient.decideCliAuthorization(requestCode, decision);
			if (version !== lookupVersion || requestCode !== userCode) return;
			completed = decision === 'approve' ? 'approved' : 'denied';
		} catch (caught) {
			if (version !== lookupVersion || requestCode !== userCode) return;
			error = caught instanceof Error ? caught.message : 'Could not update this request.';
		} finally {
			if (version === lookupVersion && requestCode === userCode) action = null;
		}
	}
</script>

<svelte:head><title>Authorize Scout CLI · Scoutpost</title></svelte:head>

<main class="authorization-shell">
	<section class="authorization-card" aria-labelledby="authorization-title">
		<span class="eyebrow">Scoutpost</span>
		<h1 id="authorization-title">Connect Scout CLI</h1>

		{#if !validCode}
			<p class="error" role="alert">This authorization code is malformed. Return to the terminal and start again.</p>
		{:else if !$authStore.authenticated}
			<p>Sign in to review this terminal connection. Signing in does not approve it.</p>
			<p class="code">Code <strong>{userCode}</strong></p>
			<button class="primary" type="button" on:click={signIn}>Sign in to review</button>
		{:else if loading}
			<p>Loading authorization request…</p>
		{:else if completed === 'approved'}
			<p class="success">Connection approved. You can close this window and return to the terminal.</p>
		{:else if completed === 'denied'}
			<p>Connection denied. You can close this window.</p>
		{:else if request}
			<div class="request-details">
				<div><span>Application</span><strong>{request.client_name}</strong></div>
				<div><span>Agent</span><strong>{request.agent_label ?? 'Scout CLI'}</strong></div>
				{#if request.device_label}<div><span>Device</span><strong>{request.device_label}</strong></div>{/if}
				<div><span>Site</span><strong>{request.site_origin}</strong></div>
				<div><span>Code</span><strong>{request.user_code}</strong></div>
			</div>
			<p class="access">{request.access}.</p>

			{#if request.status === 'pending'}
				<div class="actions">
					<button class="secondary" type="button" disabled={action !== null} on:click={() => decide('deny')}>
						{action === 'deny' ? 'Denying…' : 'Deny'}
					</button>
					<button class="primary" type="button" disabled={action !== null} on:click={() => decide('approve')}>
						{action === 'approve' ? 'Approving…' : 'Allow connection'}
					</button>
				</div>
			{:else if request.status === 'expired'}
				<p>This request expired. Return to the terminal and start again.</p>
			{:else}
				<p>This request is already {request.status} and cannot be changed.</p>
			{/if}
		{/if}

		{#if error}
			<p class="error" role="alert">{error}</p>
			{#if error.toLowerCase().includes('five') || error.toLowerCase().includes('maximum') || error.toLowerCase().includes('revoke')}
				<a href="/?connect=api">Manage API keys</a>
			{/if}
		{/if}
	</section>
</main>

<style>
	.authorization-shell {
		min-height: 100vh;
		display: grid;
		place-items: center;
		padding: 1.5rem;
		background: var(--color-bg);
		color: var(--color-ink);
	}
	.authorization-card {
		width: min(100%, 34rem);
		display: grid;
		gap: 1rem;
		padding: 2rem;
		background: var(--color-surface-alt);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xl);
		box-shadow: var(--shadow-modal);
	}
	.eyebrow { color: var(--color-ink-muted); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.08em; }
	h1, p { margin: 0; }
	h1 { font-family: var(--font-display); font-size: 1.75rem; }
	.code { font-family: var(--font-mono); }
	.request-details { display: grid; gap: 0.625rem; padding: 1rem; background: var(--color-bg); border: 1px solid var(--color-border); border-radius: var(--radius-md); }
	.request-details div { display: flex; justify-content: space-between; gap: 1rem; }
	.request-details span { color: var(--color-ink-muted); }
	.request-details strong { text-align: right; overflow-wrap: anywhere; }
	.access { color: var(--color-ink-muted); font-size: 0.875rem; }
	.actions { display: flex; justify-content: flex-end; gap: 0.75rem; }
	button { min-height: 2.5rem; padding: 0.625rem 1rem; border-radius: var(--radius-md); font: inherit; cursor: pointer; }
	button:disabled { opacity: 0.6; cursor: wait; }
	.primary { color: var(--color-bg); background: var(--color-primary); border: 1px solid var(--color-primary); }
	.secondary { color: var(--color-ink); background: transparent; border: 1px solid var(--color-border-strong); }
	.error { color: var(--color-error); }
	.success { color: var(--color-success); }
	a { color: var(--color-primary); }
</style>

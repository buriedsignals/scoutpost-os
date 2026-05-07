<script lang="ts">
	import { Settings, CheckCircle, ExternalLink } from 'lucide-svelte';
	import { fade } from 'svelte/transition';
	import { authStore } from '$lib/stores/auth';
	import { SUPPORTED_LANGUAGES, getLanguageLabel } from '$lib/i18n/constants';
	import { setLocaleFromUser } from '$lib/i18n/locale';
	import { formatTz, getTimezoneOptions, normalizeTimezone } from '$lib/utils/timezones';
	import * as m from '$lib/paraglide/messages';

	export let open = false;
	export let onClose: () => void = () => {};

	let selectedLanguage = '';
	let selectedTimezone = '';
	let healthNotificationsEnabled = true;
	let saving = false;
	let saveSuccess = false;
	let errorMessage: string | null = null;
	let initialized = false;
	const muckrockAccountUrl = '#';

	// Reset initialization when modal closes
	$: if (!open) {
		initialized = false;
	}

	// Initialize only once when modal first opens
	$: if (open && $authStore.user && !initialized) {
		selectedLanguage = $authStore.user.preferred_language || 'en';
		selectedTimezone = $authStore.user.timezone || normalizeTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
		healthNotificationsEnabled = $authStore.user.health_notifications_enabled ?? true;
		errorMessage = null;
		saveSuccess = false;
		initialized = true;
	}

	$: timezones = getTimezoneOptions(selectedTimezone);

	async function handleSave() {
		saving = true;
		errorMessage = null;

		try {
			const params: {
				preferred_language?: string;
				timezone?: string;
				health_notifications_enabled?: boolean;
			} = {};

			if (selectedLanguage !== ($authStore.user?.preferred_language || 'en')) {
				params.preferred_language = selectedLanguage;
			}
			if (selectedTimezone !== ($authStore.user?.timezone || '')) {
				params.timezone = selectedTimezone;
			}
			const currentHealth = $authStore.user?.health_notifications_enabled ?? true;
			if (healthNotificationsEnabled !== currentHealth) {
				params.health_notifications_enabled = healthNotificationsEnabled;
			}

			if (Object.keys(params).length === 0) {
				onClose();
				return;
			}

			await authStore.updatePreferences(params);

			// Update UI locale if language changed
			if (params.preferred_language) {
				setLocaleFromUser(params.preferred_language);
			}

			saveSuccess = true;
		} catch (e: unknown) {
			errorMessage = e instanceof Error ? e.message : m.preferences_failedToSave();
		} finally {
			saving = false;
		}
	}

	function handleCancel() {
		onClose();
	}

	function handleBackdropClick(event: MouseEvent) {
		if (event.target === event.currentTarget) {
			handleCancel();
		}
	}
</script>

{#if open}
	<!-- svelte-ignore a11y-click-events-have-key-events -->
	<!-- svelte-ignore a11y-no-static-element-interactions -->
	<div
		class="modal-backdrop"
		on:click={handleBackdropClick}
		on:keydown={(e) => e.key === 'Escape' && handleCancel()}
	>
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
		<form
			class="modal-panel"
			on:submit|preventDefault={handleSave}
			on:keydown={(e) => e.key === 'Escape' && handleCancel()}
		>
			{#if saveSuccess}
				<div class="success" transition:fade={{ duration: 200 }}>
					<div class="success-icon">
						<CheckCircle size={28} />
					</div>
					<h3 class="success-title">{m.preferences_updated()}</h3>
					<p class="success-body">
						{m.preferences_language()}: {getLanguageLabel(selectedLanguage)}
					</p>
					<button type="button" on:click={handleCancel} class="btn-primary">
						{m.common_done()}
					</button>
				</div>
			{:else}
				<header class="modal-header">
					<div class="modal-icon-tile">
						<Settings size={18} />
					</div>
					<div class="modal-header-text">
						<h2 class="modal-title">{m.preferences_title()}</h2>
						<p class="modal-subtitle">{m.preferences_subtitle()}</p>
					</div>
				</header>

				<div class="modal-body">
					<div class="form-field">
						<label for="pref-language" class="form-label">
							{m.preferences_language()}
						</label>
						<select
							id="pref-language"
							bind:value={selectedLanguage}
							class="form-select"
						>
							{#each SUPPORTED_LANGUAGES as lang}
								<option value={lang.code}>{lang.label}</option>
							{/each}
						</select>
						<p class="form-helper">{m.preferences_languageHint()}</p>
					</div>

					<div class="form-field">
						<label for="pref-timezone" class="form-label">
							{m.preferences_timezone()}
						</label>
						<select
							id="pref-timezone"
							bind:value={selectedTimezone}
							class="form-select"
						>
							{#each timezones as tz}
								<option value={tz}>{formatTz(tz)}</option>
							{/each}
						</select>
						<p class="form-helper">{m.preferences_timezoneHint()}</p>
					</div>

					<div class="modal-divider"></div>

					<section>
						<p class="modal-section-label">{m.preferences_notifications()}</p>
						<label class="check-row" for="pref-health-notifs">
							<input
								id="pref-health-notifs"
								type="checkbox"
								bind:checked={healthNotificationsEnabled}
								class="form-checkbox"
							/>
							<span class="check-content">
								<span class="check-title">{m.preferences_healthNotifsLabel()}</span>
								<span class="check-hint">{m.preferences_healthNotifsHint()}</span>
							</span>
						</label>
					</section>

					<div class="modal-divider"></div>

					<section>
						<p class="modal-section-label">{m.preferences_account()}</p>
						<div class="tier-row">
							<span class="tier-row-label">{m.preferences_currentTier()}</span>
							<span class="tier-badge tier-{$authStore.user?.tier ?? 'free'}">
								{($authStore.user?.tier ?? 'free')}
							</span>
						</div>
						<a
							href={muckrockAccountUrl}
							target="_blank"
							rel="noopener noreferrer"
							class="muckrock-link"
						>
							{m.preferences_manageMuckrock()}
							<ExternalLink size={14} />
						</a>
						<p class="form-helper">{m.preferences_manageMuckrockHint()}</p>
					</section>

					{#if errorMessage}
						<p class="error-text">{errorMessage}</p>
					{/if}
				</div>

				<footer class="modal-footer">
					<button type="button" on:click={handleCancel} class="btn-secondary">
						{m.common_cancel()}
					</button>
					<button type="submit" disabled={saving} class="btn-primary">
						{saving ? m.common_saving() : m.common_save()}
					</button>
				</footer>
			{/if}
		</form>
	</div>
{/if}

<style>
	.check-row {
		display: flex;
		align-items: flex-start;
		gap: 0.625rem;
		cursor: pointer;
	}

	.check-row .form-checkbox {
		margin-top: 0.1875rem;
	}

	.check-content { flex: 1; display: flex; flex-direction: column; gap: 0.125rem; }
	.check-title { font-size: 0.875rem; color: var(--color-ink); }
	.check-hint { font-size: 0.75rem; color: var(--color-ink-subtle); line-height: 1.45; }

	.tier-row {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		margin-bottom: 0.75rem;
	}

	.tier-row-label {
		font-size: 0.875rem;
		color: var(--color-ink);
	}

	.tier-badge {
		display: inline-flex;
		align-items: center;
		font-family: var(--font-mono);
		font-size: 0.625rem;
		font-weight: 500;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		padding: 0.1875rem 0.5rem;
		border: 1px solid;
	}
	.tier-free {
		background: var(--color-surface);
		color: var(--color-ink-muted);
		border-color: var(--color-border-strong);
	}
	.tier-pro {
		background: var(--color-secondary-soft);
		color: var(--color-secondary);
		border-color: var(--color-secondary);
	}
	.tier-team {
		background: var(--color-primary-soft);
		color: var(--color-primary-deep);
		border-color: var(--color-primary);
	}

	.muckrock-link {
		display: inline-flex;
		align-items: center;
		gap: 0.3125rem;
		font-family: var(--font-body);
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--color-primary);
		text-decoration: none;
		border-bottom: 1px solid var(--color-primary-soft);
		padding-bottom: 1px;
		transition: border-color 150ms ease;
	}
	.muckrock-link:hover { border-bottom-color: var(--color-primary); }

	.error-text {
		margin-top: 1rem;
		padding: 0.5rem 0.75rem;
		background: rgba(179, 62, 46, 0.08);
		border-left: 3px solid var(--color-error);
		color: var(--color-error);
		font-size: 0.8125rem;
	}

	.success {
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 2.5rem 1.5rem;
		gap: 0.875rem;
	}

	.success-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 3rem;
		height: 3rem;
		background: rgba(47, 143, 95, 0.12);
		color: var(--color-success);
		border: 1px solid var(--color-success);
	}

	.success-title {
		font-family: var(--font-display);
		font-size: 1.25rem;
		font-weight: 600;
		color: var(--color-ink);
		margin: 0;
		letter-spacing: -0.01em;
	}

	.success-body {
		font-size: 0.875rem;
		color: var(--color-ink-muted);
		margin: 0;
		text-align: center;
	}
</style>

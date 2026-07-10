<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { authStore } from '$lib/stores/auth';
	import { notificationStore } from '$lib/stores/notifications';
	import { initLocaleFromCache, setLocaleFromUser } from '$lib/i18n/locale';
	import OnboardingModal from '$lib/components/modals/OnboardingModal.svelte';
	import OnboardingVideoModal from '$lib/components/modals/OnboardingVideoModal.svelte';
	import type { GeocodedLocation } from '$lib/types';

	import '../app.css';

	// Initialize locale from cache immediately to prevent flash of wrong language
	if (browser) {
		initLocaleFromCache();
	}

	const isSupabaseDeployment = import.meta.env.PUBLIC_DEPLOYMENT_TARGET === 'supabase';

let timezoneModalOpen = false;
let timezoneSaving = false;
let timezoneError: string | null = null;
let isInitializing = false;
let needsInitialization = false;
let notificationsChecked = false;
let timezoneVerified = false;
let timezoneCheckPerformed = false;

// Extended onboarding flow state
let videoModalOpen = false;

const TIMEZONE_FLAG_KEY = 'cojournalist_timezone_verified';

function markTimezoneVerified(userId?: string | null) {
	timezoneVerified = true;
	timezoneModalOpen = false;
	if (typeof localStorage !== 'undefined') {
		const stamp = userId ? `${userId}:${Date.now()}` : '1';
		localStorage.setItem(TIMEZONE_FLAG_KEY, stamp);
	}
}

	// Initialize auth on mount
	onMount(() => {
		let unsubscribe: (() => void) | null = null;
		let cancelled = false;

		(async () => {
			await authStore.init();
			if (cancelled) return;

			const loginPath = '/login';
			const publicPaths = ['/login', '/setup', '/terms', '/faq', '/acknowledgements', '/docs', '/skills', '/swagger'];

			unsubscribe = authStore.subscribe(async (state) => {
				if (!state.authenticated && !publicPaths.includes($page.url.pathname)) {
					// Redirect to the auth provider's login page
					await goto(loginPath);
					return;
				}

				if (state.authenticated && !notificationsChecked) {
					// Check for new notifications from active jobs
					notificationStore.checkActiveJobs();
					notificationsChecked = true;
				}

				// Update locale from user preference when auth loads
				if (state.authenticated && state.user?.preferred_language) {
					setLocaleFromUser(state.user.preferred_language);
				}

				// Check localStorage for timezone verification, but validate it matches the CURRENT user
				// This prevents a previous user's localStorage entry from skipping onboarding for a new user
				if (state.authenticated && state.user && !timezoneVerified) {
					if (typeof localStorage !== 'undefined') {
						const stored = localStorage.getItem(TIMEZONE_FLAG_KEY);
						if (stored) {
							const storedUserId = stored.split(':')[0];
							const currentUserId = state.user.user_id;
							// Only mark verified if the stored ID matches the current user
							if (storedUserId === currentUserId) {
								timezoneVerified = true;
							}
						}
					}
				}

				needsInitialization = !isSupabaseDeployment && Boolean(state.user?.needs_initialization);

				// Only prompt for NEW users who need initialization
				// Existing users with missing timezone will be prompted when they try to schedule monitoring
				const shouldPromptTimezone =
					!isSupabaseDeployment &&
					state.authenticated &&
					state.user &&
					!timezoneVerified &&
					needsInitialization;

				// If timezone is present and we haven't marked verified yet, mark it now and avoid future prompts.
				if (state.authenticated && state.user?.timezone && !timezoneVerified) {
					markTimezoneVerified(state.user.user_id);
				}

				if (shouldPromptTimezone) {
					timezoneModalOpen = true;
					timezoneCheckPerformed = true;
				} else if (!timezoneSaving && !isInitializing) {
					timezoneModalOpen = false;
					timezoneError = null;
				}
			});
		})();

		return () => {
			cancelled = true;
			unsubscribe?.();
		};
	});

async function handleOnboardingSave(detail: { timezone: string; location: GeocodedLocation | null; preferred_language: string }) {
	const { timezone, location, preferred_language } = detail;
	timezoneSaving = true;
	timezoneError = null;
	const requiresInitialization = needsInitialization;

	try {
		if (requiresInitialization && !isSupabaseDeployment) {
			isInitializing = true;
			await authStore.initializeUser(timezone, location, preferred_language);
		} else {
			await authStore.updatePreferences({
				timezone,
				preferred_language
			});
		}

		markTimezoneVerified($authStore.user?.user_id);

		// Update locale to match the selected language
		setLocaleFromUser(preferred_language);

		// Verify timezone was saved correctly
		const currentUser = $authStore.user;

		if (currentUser?.timezone === timezone) {
			timezoneModalOpen = false;
		} else {
			timezoneError = 'Timezone was saved but could not be verified. Please refresh the page.';
		}
	} catch (error) {
		if (error instanceof Error) {
			timezoneError = error.message;
		} else {
			timezoneError = 'Unable to save timezone. Please try again.';
		}
	} finally {
		timezoneSaving = false;
		if (requiresInitialization) {
			isInitializing = false;
		}
	}
}

function handleVideoReady() {
	videoModalOpen = false;
}
</script>

<slot />


{#if !isSupabaseDeployment}
	<OnboardingModal
		open={timezoneModalOpen}
		saving={timezoneSaving}
		errorMessage={timezoneError}
		initialTimezone={$authStore.user?.timezone ?? null}
		onSave={handleOnboardingSave}
	/>

	<OnboardingVideoModal
		open={videoModalOpen}
		onReady={handleVideoReady}
	/>
{/if}

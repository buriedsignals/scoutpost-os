/**
 * Supabase Auth Store -- Supabase Auth authentication and user state.
 *
 * Replacement for auth-muckrock.ts when PUBLIC_DEPLOYMENT_TARGET=supabase.
 * Uses @supabase/supabase-js for email/password authentication.
 *
 * USED BY: auth.ts (conditional loader)
 * DEPENDS ON: @supabase/supabase-js, $lib/config/api (buildApiUrl)
 */
import { browser } from '$app/environment';
import { writable, derived } from 'svelte/store';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { User, AuthState, GeocodedLocation } from '$lib/types';
import { buildApiUrl } from '$lib/config/api';
import { IS_LOCAL_DEMO_MODE } from '$lib/demo/state';

const SUPABASE_URL = import.meta.env.PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = import.meta.env.PUBLIC_SUPABASE_ANON_KEY ?? '';
const PUBLIC_MUCKROCK_ENABLED = (import.meta.env.PUBLIC_MUCKROCK_ENABLED ?? '').trim().toLowerCase() === 'true';
const PUBLIC_MUCKROCK_BROKER_URL = (import.meta.env.PUBLIC_MUCKROCK_BROKER_URL ?? '').trim();
const PUBLIC_MUCKROCK_POST_LOGIN_REDIRECT = (
	import.meta.env.PUBLIC_MUCKROCK_POST_LOGIN_REDIRECT ?? ''
).trim();
const LOCALHOST_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

let supabase: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
	if (!supabase) {
		supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
	}
	return supabase;
}

const initialState: AuthState = {
	authenticated: false,
	user: null
};

type RedirectLocation = Pick<Location, 'href'>;
type BrowserLocationLike = Pick<Location, 'origin' | 'hostname'>;

function normalizeLocalPostLoginRedirect(raw: string | null): string | null {
	if (!raw) return null;

	try {
		const redirect = new URL(raw);
		if (!LOCALHOST_HOSTS.has(redirect.hostname)) return null;
		if (redirect.pathname !== '/auth/callback') return null;
		if (redirect.protocol !== 'http:' && redirect.protocol !== 'https:') return null;
		return redirect.toString();
	} catch {
		return null;
	}
}

export function buildMuckRockLoginUrl(
	supabaseUrl: string,
	brokerUrl: string | null,
	currentLocation: BrowserLocationLike | null,
	isDev: boolean,
	postLoginRedirectOverride: string | null = null
): string {
	const loginUrl = brokerUrl
		? new URL(brokerUrl)
		: new URL(`${supabaseUrl.replace(/\/$/, '')}/functions/v1/auth-muckrock/login`);

	// Local dev can ask the MuckRock broker to hand the final Supabase magiclink
	// back to the local /auth/callback route. Production keeps the default.
	if (isDev) {
		const postLoginRedirect =
			normalizeLocalPostLoginRedirect(postLoginRedirectOverride) ??
			(currentLocation && LOCALHOST_HOSTS.has(currentLocation.hostname)
				? `${currentLocation.origin}/auth/callback`
				: null);

		if (postLoginRedirect) {
			loginUrl.searchParams.set('post_login_redirect', postLoginRedirect);
		}
	}

	return loginUrl.toString();
}

export function buildSessionUser(
	sessionUser: {
		id: string;
		email?: string | null;
		user_metadata?: Record<string, unknown> | null;
	},
	localDemoMode = IS_LOCAL_DEMO_MODE
): User {
	const metadata = (sessionUser.user_metadata ?? {}) as Partial<User> & Record<string, unknown>;

	return {
		user_id: sessionUser.id,
		email: sessionUser.email ?? null,
		muckrock_id: String(metadata.muckrock_id ?? sessionUser.id),
		username: typeof metadata.username === 'string' ? metadata.username : undefined,
		credits: typeof metadata.credits === 'number' ? metadata.credits : localDemoMode ? 100 : 0,
		timezone: typeof metadata.timezone === 'string' ? metadata.timezone : null,
		default_location: (metadata.default_location as GeocodedLocation | null | undefined) ?? null,
		needs_initialization: localDemoMode ? false : Boolean(metadata.needs_initialization),
		onboarding_completed: localDemoMode ? true : Boolean(metadata.onboarding_completed),
		preferred_language:
			typeof metadata.preferred_language === 'string' ? metadata.preferred_language : null,
		tier:
			metadata.tier === 'pro' || metadata.tier === 'team' || metadata.tier === 'free'
				? metadata.tier
				: 'free',
		upgrade_url: typeof metadata.upgrade_url === 'string' ? metadata.upgrade_url : undefined,
		team_upgrade_url:
			typeof metadata.team_upgrade_url === 'string' ? metadata.team_upgrade_url : undefined,
		excluded_domains: Array.isArray(metadata.excluded_domains)
			? metadata.excluded_domains.filter((value): value is string => typeof value === 'string')
			: [],
		team: (metadata.team as User['team']) ?? null,
		org_id:
			typeof metadata.org_id === 'string' || metadata.org_id === null
				? metadata.org_id
				: null,
		health_notifications_enabled:
			typeof metadata.health_notifications_enabled === 'boolean'
				? metadata.health_notifications_enabled
				: true
	};
}

export function createAuthStore(
	redirectLocation: RedirectLocation | null = browser ? window.location : null,
	currentLocation: BrowserLocationLike | null = browser ? window.location : null
) {
	const { subscribe, set, update } = writable<AuthState>(initialState);

	let initialized = false;

	return {
		subscribe,

		/**
		 * Initialize auth state by checking Supabase session.
		 */
		async init() {
			if (!browser) return;
			if (initialized) return;
			initialized = true;

			const sb = getSupabase();

			try {
				const {
					data: { session }
				} = await sb.auth.getSession();

				if (session) {
					// Authentication proven by the session alone — don't gate the
					// authenticated flag on a profile fetch. Use the session's
					// user + metadata immediately so a refresh never bounces back
					// to /login while we wait on the backend.
					const sessionUser = buildSessionUser(session.user);
					set({ authenticated: true, user: sessionUser });

					// Try to enrich with the full profile from the `user` Edge
					// Function. Silently fall back to session-derived user if
					// the endpoint isn't reachable.
					if (!IS_LOCAL_DEMO_MODE) {
						try {
							const response = await fetch(buildApiUrl('/user/me'), {
								headers: {
									Authorization: `Bearer ${session.access_token}`
								}
							});
							if (response.ok) {
								const data = await response.json();
								update((s) => ({ ...s, user: { ...sessionUser, ...data } }));
							}
						} catch {
							/* keep session-derived user */
						}
					}
				} else {
					set({ authenticated: false, user: null });
				}
			} catch {
				set({ authenticated: false, user: null });
			}

			// Listen for auth state changes (token refresh, sign out)
			sb.auth.onAuthStateChange(async (event, session) => {
				if (event === 'SIGNED_OUT' || !session) {
					set({ authenticated: false, user: null });
					initialized = false;
				}
			});
		},

		/**
		 * Hosted SaaS deployments still start sign-in via the MuckRock broker.
		 * OSS/self-hosted deployments keep the in-page email/password form.
		 */
		login() {
			if (!browser || !redirectLocation) return;
			if (PUBLIC_MUCKROCK_ENABLED) {
				redirectLocation.href = buildMuckRockLoginUrl(
					SUPABASE_URL,
					PUBLIC_MUCKROCK_BROKER_URL || null,
					currentLocation,
					import.meta.env.DEV,
					PUBLIC_MUCKROCK_POST_LOGIN_REDIRECT || null
				);
				return;
			}
			redirectLocation.href = '/login';
		},

		/**
		 * Sign out via Supabase.
		 */
		async signOut() {
			const sb = getSupabase();
			await sb.auth.signOut({ scope: 'local' });
			set({ authenticated: false, user: null });
			initialized = false;
			if (browser && redirectLocation) {
				redirectLocation.href = '/login';
			}
		},

		/**
		 * Refresh user data from backend.
		 */
		async refreshUser() {
			if (!browser) return;

			const sb = getSupabase();
			const {
				data: { session }
			} = await sb.auth.getSession();

			if (!session) return;

			try {
				const response = await fetch(buildApiUrl('/user/me'), {
					headers: {
						Authorization: `Bearer ${session.access_token}`
					}
				});

				if (response.ok) {
					const data = await response.json();
					update((s) => ({ ...s, user: data, authenticated: true }));
				}
			} catch {
				// Silent fail
			}
		},

		/**
		 * Optimistically update the current credit balance in the store.
		 * Called after a scout run returns a new balance in its response; the
		 * next /user/me refresh reconciles against the server-of-record.
		 */
		setCredits(credits: number) {
			update((state) => {
				if (!state.user) return state;
				return {
					...state,
					user: {
						...state.user,
						credits
					}
				};
			});
		},

		/**
		 * Get the Supabase access token for API calls.
		 */
		async getToken(): Promise<string | null> {
			if (!browser) return null;
			const sb = getSupabase();
			const {
				data: { session }
			} = await sb.auth.getSession();
			return session?.access_token ?? null;
		},

		/**
		 * Initialize a newly signed-up Supabase user without relying on FastAPI.
		 */
		async initializeUser(
			timezone?: string,
			location?: GeocodedLocation | null,
			preferredLanguage?: string
		) {
			if (!timezone) {
				throw new Error('Please choose a timezone to finish onboarding.');
			}

			const sb = getSupabase();
			const {
				data: { session }
			} = await sb.auth.getSession();

			if (!session) {
				throw new Error('Not authenticated');
			}

			const response = await fetch(buildApiUrl('/user/preferences'), {
				method: 'PATCH',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${session.access_token}`
				},
				body: JSON.stringify({
					timezone,
					language: preferredLanguage ?? undefined,
					default_location: location ?? undefined,
					onboarding_completed: true
				})
			});

			const payload = await response.json();

			if (!response.ok) {
				throw new Error(payload?.detail || payload?.error || 'Failed to initialize user');
			}

			const meResponse = await fetch(buildApiUrl('/user/me'), {
				headers: {
					Authorization: `Bearer ${session.access_token}`
				}
			});
			if (!meResponse.ok) {
				throw new Error('Failed to refresh user after initialization');
			}

			const currentUser = (await meResponse.json()) as User;
			set({ authenticated: true, user: currentUser });
			return currentUser;
		},

		/**
		 * Update user preferences via backend API.
		 */
		async updatePreferences(params: {
			preferred_language?: string;
			timezone?: string;
			health_notifications_enabled?: boolean;
		}): Promise<void> {
			const { apiClient } = await import('$lib/api-client');
			const result = await apiClient.updateUserPreferences(params);

			if (!result.success) {
				throw new Error('Failed to update preferences');
			}

			update((state) => {
				if (!state.user) return state;
				return {
					...state,
					user: {
						...state.user,
						...(params.preferred_language && {
							preferred_language: params.preferred_language
						}),
						...(params.timezone && { timezone: params.timezone }),
						...(params.health_notifications_enabled !== undefined && {
							health_notifications_enabled: params.health_notifications_enabled
						})
					}
				};
			});
		}
	};
}

export const authStore = createAuthStore();
export const currentUser = derived(authStore, ($authStore) => $authStore.user);
export const auth = authStore;

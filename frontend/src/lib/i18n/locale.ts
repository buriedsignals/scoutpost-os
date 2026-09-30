/**
 * Locale Management -- initialize and sync UI locale with user preference.
 *
 * USED BY: PreferencesModal.svelte, +layout.svelte
 * DEPENDS ON: $lib/paraglide/runtime, ./constants (isSupported)
 *
 * Provides initLocaleFromCache() for instant locale restore on page load,
 * setLocaleFromUser() for applying a user's saved preference after auth,
 * and getCurrentLocale() for reading the active locale. Detection cascade:
 * user preference > current Paraglide locale > browser language > 'en'.
 */
import { setLocale, getLocale, localStorageKey } from '$lib/paraglide/runtime';
import { isSupported, type SupportedLanguageCode } from './constants';

/**
 * Initialize locale from localStorage cache.
 * Call this immediately on page load to prevent flash of wrong language.
 */
export function initLocaleFromCache(): void {
	if (typeof localStorage === 'undefined') return;

	const cached = localStorage.getItem(localStorageKey);
	if (cached && isSupported(cached)) {
		// Don't reload - this is called on page load to restore the cached locale
		setLocale(cached as SupportedLanguageCode, { reload: false });
	}
	if (typeof document !== 'undefined') {
		document.documentElement.lang = getCurrentLocale();
	}
}

/**
 * Update locale from user preference.
 * Call this after auth loads to apply the user's saved preference.
 */
export function setLocaleFromUser(preferredLanguage: string | null | undefined): void {
	const locale = detectLocale(preferredLanguage);
	setLocale(locale);
	// localStorage is automatically updated by Paraglide's localStorage strategy
}

/**
 * Detect the appropriate locale based on user preference or browser settings.
 */
function detectLocale(userPreference: string | null | undefined): SupportedLanguageCode {
	// 1. User preference takes priority
	if (userPreference && isSupported(userPreference)) {
		return userPreference as SupportedLanguageCode;
	}

	// 2. Check if current locale is already supported
	const currentLocale = getLocale();
	if (currentLocale && isSupported(currentLocale)) {
		return currentLocale as SupportedLanguageCode;
	}

	// 3. Browser detection fallback
	if (typeof navigator !== 'undefined') {
		const browserLang = navigator.language?.slice(0, 2);
		if (browserLang && isSupported(browserLang)) {
			return browserLang as SupportedLanguageCode;
		}
	}

	// 4. Default to English
	return 'en';
}

/**
 * Get the current locale.
 */
export function getCurrentLocale(): SupportedLanguageCode {
	const locale = getLocale();
	if (locale && isSupported(locale)) {
		return locale as SupportedLanguageCode;
	}
	return 'en';
}

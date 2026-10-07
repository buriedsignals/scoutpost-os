/**
 * Best-effort device and browser from the user agent, so a feedback report
 * says where it came from even when the reporter skips the dropdowns
 * (BUR-33/34 arrived with neither). Values match the FeedbackModal options.
 */
export function detectClient(userAgent: string): { device: string; browser: string } {
	const ua = userAgent || '';
	const device = /iPhone/.test(ua)
		? 'iPhone'
		: /iPad/.test(ua)
			? 'iPad'
			: /Android/.test(ua)
				? 'Android'
				: /Windows/.test(ua)
					? 'Windows'
					: /Macintosh|Mac OS X/.test(ua)
						? 'Mac'
						: /Linux|X11/.test(ua)
							? 'Linux'
							: '';
	// Order matters: Edge and Firefox-on-iOS UAs also contain "Chrome"/"Safari".
	const browser = /Edg\//.test(ua)
		? 'Edge'
		: /Firefox\/|FxiOS\//.test(ua)
			? 'Firefox'
			: /Chrome\/|CriOS\//.test(ua)
				? 'Chrome'
				: /Safari\//.test(ua)
					? 'Safari'
					: '';
	return { device, browser };
}

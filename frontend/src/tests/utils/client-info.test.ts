import { describe, expect, it } from 'vitest';
import { detectClient } from '$lib/utils/client-info';

// Real user-agent strings; reports used to arrive with no device or browser
// when the reporter skipped the dropdowns (BUR-33/34).
describe('detectClient', () => {
	it.each([
		[
			'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
			{ device: 'Windows', browser: 'Edge' },
		],
		[
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
			{ device: 'Mac', browser: 'Safari' },
		],
		[
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
			{ device: 'Mac', browser: 'Chrome' },
		],
		[
			'Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0',
			{ device: 'Linux', browser: 'Firefox' },
		],
		[
			'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
			{ device: 'Android', browser: 'Chrome' },
		],
		[
			'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1',
			{ device: 'iPhone', browser: 'Chrome' },
		],
		['', { device: '', browser: '' }],
	])('%s', (userAgent, expected) => {
		expect(detectClient(userAgent)).toEqual(expected);
	});
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const appHtml = readFileSync(resolve(process.cwd(), 'src/app.html'), 'utf8');
const document = new DOMParser().parseFromString(appHtml, 'text/html');

function metaContent(selector: string): string | null {
	return document.querySelector<HTMLMetaElement>(selector)?.content ?? null;
}

describe('social card metadata', () => {
	it('uses canonical absolute URLs for social crawlers', () => {
		expect(metaContent('meta[property="og:url"]')).toBe('https://scoutpost.ai/');
		expect(metaContent('meta[property="og:image"]')).toBe(
			'https://scoutpost.ai/og-image.png'
		);
		expect(metaContent('meta[name="twitter:image"]')).toBe(
			'https://scoutpost.ai/og-image.png'
		);
	});
});

import { describe, it, expect } from 'vitest';
import { parseExcludedDomains, parsePrioritySources } from '$lib/utils/domains';

describe.each([
	['parseExcludedDomains', parseExcludedDomains],
	['parsePrioritySources', parsePrioritySources]
])('%s', (_name, parse) => {
	it('parses simple domain list', () => {
		expect(parse('example.com\nnews.org')).toEqual(['example.com', 'news.org']);
	});

	it('strips protocols and www', () => {
		expect(parse('https://www.example.com\nhttp://news.org')).toEqual([
			'example.com',
			'news.org'
		]);
	});

	it('strips paths', () => {
		expect(parse('example.com/some/path\nnews.org/')).toEqual([
			'example.com',
			'news.org'
		]);
	});

	it('filters empty lines and whitespace', () => {
		expect(parse('example.com\n\n  \nnews.org\n')).toEqual([
			'example.com',
			'news.org'
		]);
	});

	it('filters entries without a dot', () => {
		expect(parse('example.com\ncom\njusttext\nnews.org')).toEqual([
			'example.com',
			'news.org'
		]);
	});

	it('returns empty array for empty input', () => {
		expect(parse('')).toEqual([]);
	});

	it('trims whitespace from each line', () => {
		expect(parse('  example.com  \n  news.org  ')).toEqual([
			'example.com',
			'news.org'
		]);
	});
});

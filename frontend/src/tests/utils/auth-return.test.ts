import { describe, expect, it } from 'vitest';
import {
	consumeAuthReturn,
	rememberAuthReturn,
	safeAuthReturn
} from '$lib/utils/auth-return';

function memoryStorage() {
	const values = new Map<string, string>();
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
		removeItem: (key: string) => values.delete(key)
	};
}

describe('CLI auth return path', () => {
	it('round-trips the approval route once', () => {
		const storage = memoryStorage();
		expect(rememberAuthReturn('/cli/authorize?user_code=abcd-2345', storage)).toBe(true);
		expect(consumeAuthReturn(storage)).toBe('/cli/authorize?user_code=ABCD-2345');
		expect(consumeAuthReturn(storage)).toBe('/');
	});

	it('rejects open redirects, extra parameters, and unrelated routes', () => {
		for (const value of [
			'https://evil.example/cli/authorize?user_code=ABCD-2345',
			'//evil.example/cli/authorize?user_code=ABCD-2345',
			'/login?user_code=ABCD-2345',
			'/cli/authorize?user_code=ABCD-2345&next=https://evil.example',
			'/cli/authorize?user_code=bad'
		]) {
			expect(safeAuthReturn(value)).toBeNull();
		}
	});

	it('fails closed when session storage is unavailable', () => {
		const blocked = {
			getItem: () => {
				throw new DOMException('blocked');
			},
			setItem: () => {
				throw new DOMException('blocked');
			},
			removeItem: () => {
				throw new DOMException('blocked');
			}
		};
		expect(rememberAuthReturn('/cli/authorize?user_code=ABCD-2345', blocked)).toBe(false);
		expect(consumeAuthReturn(blocked)).toBe('/');
	});
});

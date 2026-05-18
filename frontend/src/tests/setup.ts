import '@testing-library/jest-dom/vitest';

function createStorageMock(): Storage {
	const store = new Map<string, string>();

	return {
		get length() {
			return store.size;
		},
		clear() {
			store.clear();
		},
		getItem(key: string) {
			return store.has(key) ? store.get(key)! : null;
		},
		key(index: number) {
			return Array.from(store.keys())[index] ?? null;
		},
		removeItem(key: string) {
			store.delete(key);
		},
		setItem(key: string, value: string) {
			store.set(key, String(value));
		}
	};
}

if (typeof globalThis.localStorage === 'undefined' || typeof globalThis.localStorage.clear !== 'function') {
	Object.defineProperty(globalThis, 'localStorage', {
		value: createStorageMock(),
		configurable: true
	});
}

if (typeof Element !== 'undefined' && typeof Element.prototype.animate !== 'function') {
	Element.prototype.animate = function () {
		return {
			cancel: () => {},
			finished: Promise.resolve()
		} as unknown as Animation;
	};
}

if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
	Element.prototype.scrollIntoView = function () {};
}

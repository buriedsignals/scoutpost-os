const STORAGE_KEY = 'scout:authReturn';

interface StorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

export function safeAuthReturn(value: string | null | undefined): string | null {
	if (!value || !value.startsWith('/') || value.startsWith('//')) return null;
	try {
		const url = new URL(value, 'https://scoutpost.invalid');
		if (url.origin !== 'https://scoutpost.invalid') return null;
		if (url.pathname !== '/cli/authorize') return null;
		if ([...url.searchParams.keys()].some((key) => key !== 'user_code')) return null;
		const code = url.searchParams.get('user_code');
		if (!code || !/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/i.test(code)) return null;
		return `${url.pathname}?user_code=${encodeURIComponent(code.toUpperCase())}`;
	} catch {
		return null;
	}
}

export function rememberAuthReturn(
	value: string,
	storage: StorageLike = sessionStorage
): boolean {
	const safe = safeAuthReturn(value);
	if (!safe) return false;
	try {
		storage.setItem(STORAGE_KEY, safe);
		return true;
	} catch {
		return false;
	}
}

export function consumeAuthReturn(storage: StorageLike = sessionStorage): string {
	try {
		const value = storage.getItem(STORAGE_KEY);
		storage.removeItem(STORAGE_KEY);
		return safeAuthReturn(value) ?? '/';
	} catch {
		return '/';
	}
}

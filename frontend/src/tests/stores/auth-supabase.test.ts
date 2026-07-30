import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createClientMock } = vi.hoisted(() => ({
	createClientMock: vi.fn()
}));

vi.mock('@supabase/supabase-js', () => ({
	createClient: createClientMock
}));

async function loadAuthStore() {
	vi.resetModules();
	return import('$lib/stores/auth-supabase');
}

describe('auth-supabase login', () => {
	beforeEach(() => {
		vi.unstubAllEnvs();
		createClientMock.mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it('redirects to the MuckRock broker when PUBLIC_MUCKROCK_ENABLED=true', async () => {
		vi.stubEnv('PUBLIC_SUPABASE_URL', 'http://localhost:3000/');
		vi.stubEnv('PUBLIC_MUCKROCK_ENABLED', 'true');

		const { createAuthStore } = await loadAuthStore();
		const redirectLocation = { href: '' };
		const auth = createAuthStore(redirectLocation);
		auth.login();

		expect(redirectLocation.href).toBe(
			'http://localhost:3000/functions/v1/auth-muckrock/login?post_login_redirect=http%3A%2F%2Flocalhost%3A3000%2Fauth%2Fcallback'
		);
	});

	it('adds a localhost callback handoff for local dev logins', async () => {
		const { buildMuckRockLoginUrl } = await loadAuthStore();
		const loginUrl = buildMuckRockLoginUrl(
			'https://newsroom-project.supabase.co',
			null,
			{ origin: 'http://localhost:5173', hostname: 'localhost' },
			true
		);

		expect(loginUrl).toBe(
			'https://newsroom-project.supabase.co/functions/v1/auth-muckrock/login?post_login_redirect=http%3A%2F%2Flocalhost%3A5173%2Fauth%2Fcallback'
		);
	});

	it('prefers an explicit local callback override for hosted dev auth', async () => {
		const { buildMuckRockLoginUrl } = await loadAuthStore();
		const loginUrl = buildMuckRockLoginUrl(
			'https://newsroom-project.supabase.co',
			null,
			{ origin: 'http://127.0.0.1:4173', hostname: '127.0.0.1' },
			true,
			'http://localhost:5173/auth/callback'
		);

		expect(loginUrl).toBe(
			'https://newsroom-project.supabase.co/functions/v1/auth-muckrock/login?post_login_redirect=http%3A%2F%2Flocalhost%3A5173%2Fauth%2Fcallback'
		);
	});

	it('uses an explicit broker override when configured', async () => {
		const { buildMuckRockLoginUrl } = await loadAuthStore();
		const loginUrl = buildMuckRockLoginUrl(
			'https://newsroom-project.supabase.co',
			'http://127.0.0.1:54321/functions/v1/auth-muckrock/login',
			{ origin: 'http://localhost:5173', hostname: 'localhost' },
			true
		);

		expect(loginUrl).toBe(
			'http://127.0.0.1:54321/functions/v1/auth-muckrock/login?post_login_redirect=http%3A%2F%2Flocalhost%3A5173%2Fauth%2Fcallback'
		);
	});

	it('keeps the in-page login route when PUBLIC_MUCKROCK_ENABLED=false', async () => {
		vi.stubEnv('PUBLIC_SUPABASE_URL', 'http://localhost:3000/');
		vi.stubEnv('PUBLIC_MUCKROCK_ENABLED', 'false');

		const { createAuthStore } = await loadAuthStore();
		const redirectLocation = { href: '' };
		const auth = createAuthStore(redirectLocation);
		auth.login();

		expect(redirectLocation.href).toBe('/login');
	});

	it('uses the explicit dev callback override when the auth store starts login', async () => {
		vi.stubEnv('PUBLIC_SUPABASE_URL', 'https://newsroom-project.supabase.co');
		vi.stubEnv('PUBLIC_MUCKROCK_ENABLED', 'true');
		vi.stubEnv('PUBLIC_MUCKROCK_POST_LOGIN_REDIRECT', 'http://localhost:5173/auth/callback');

		const { createAuthStore } = await loadAuthStore();
		const redirectLocation = { href: '' };
		const auth = createAuthStore(redirectLocation, {
			origin: 'http://127.0.0.1:4173',
			hostname: '127.0.0.1'
		});
		auth.login();

		expect(redirectLocation.href).toBe(
			'https://newsroom-project.supabase.co/functions/v1/auth-muckrock/login?post_login_redirect=http%3A%2F%2Flocalhost%3A5173%2Fauth%2Fcallback'
		);
	});

	it('builds a stable fallback profile for local demo mode', async () => {
		const { buildSessionUser } = await loadAuthStore();
		const user = buildSessionUser(
			{
				id: 'user-1',
				email: 'demo@local.test',
				user_metadata: {}
			},
			true
		);

		expect(user.user_id).toBe('user-1');
		expect(user.muckrock_id).toBe('user-1');
		expect(user.credits).toBe(100);
		expect(user.needs_initialization).toBe(false);
		expect(user.onboarding_completed).toBe(true);
		expect(user.tier).toBe('free');
	});

	it('signs out only the browser session so MCP and CLI sessions stay valid', async () => {
		vi.stubEnv('PUBLIC_SUPABASE_URL', 'https://newsroom-project.supabase.co');
		vi.stubEnv('PUBLIC_SUPABASE_ANON_KEY', 'test-anon-key');
		const signOut = vi.fn().mockResolvedValue({ error: null });
		createClientMock.mockReturnValue({ auth: { signOut } });

		const { createAuthStore } = await loadAuthStore();
		const redirectLocation = { href: '' };
		const auth = createAuthStore(redirectLocation);

		await auth.signOut();

		expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
		expect(redirectLocation.href).toBe('/login');
	});
});

import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LoginPage from '../../routes/login/+page.svelte';

vi.mock('$lib/stores/auth', async () => {
	const { readable } = await import('svelte/store');
	const authState = readable({ authenticated: false, user: null });
	return {
		auth: {
			subscribe: authState.subscribe,
			login: vi.fn()
		}
	};
});

afterEach(() => {
	cleanup();
});

describe('login page product demo', () => {
	it('keeps the YouTube player at or above its minimum supported height', () => {
		render(LoginPage);

		const player = screen.getByTitle('Scoutpost product demo');
		const frame = player.parentElement;

		expect(frame).not.toBeNull();
		expect(getComputedStyle(frame!).minHeight).toBe('200px');
	});
});

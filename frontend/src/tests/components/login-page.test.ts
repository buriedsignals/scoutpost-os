import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
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

// jsdom has no modal <dialog>; the page only needs showModal to exist.
HTMLDialogElement.prototype.showModal = vi.fn();

afterEach(() => {
	cleanup();
});

describe('login page product demo', () => {
	it('keeps the YouTube player at or above its minimum supported height', async () => {
		render(LoginPage);
		expect(screen.queryByTitle('Scoutpost product demo')).toBeNull();

		await fireEvent.click(screen.getByRole('button', { name: 'See Scoutpost in action' }));

		const player = await screen.findByTitle('Scoutpost product demo');
		const frame = player.parentElement;

		expect(frame).not.toBeNull();
		expect(getComputedStyle(frame!).minHeight).toBe('200px');
	});
});

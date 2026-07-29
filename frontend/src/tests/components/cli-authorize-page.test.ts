import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CliAuthorizePage from '../../routes/cli/authorize/+page.svelte';

interface AuthState {
	authenticated: boolean;
	user: { id: string } | null;
}

interface PageState {
	url: URL;
	params: Record<string, never>;
	route: { id: string };
	status: number;
	error: null;
	data: Record<string, never>;
	form: null;
}

const testState = vi.hoisted(() => ({
	setAuthenticated: null as null | ((value: AuthState) => void),
	setPage: null as null | ((value: PageState) => void),
	login: vi.fn(),
	getRequest: vi.fn(),
	decide: vi.fn()
}));

vi.mock('$app/stores', async () => {
	const { writable } = await import('svelte/store');
	const state = writable({
		url: new URL('https://scoutpost.ai/cli/authorize?user_code=ABCD-2345'),
		params: {},
		route: { id: '/cli/authorize' },
		status: 200,
		error: null,
		data: {},
		form: null
	});
	testState.setPage = state.set;
	return {
		page: { subscribe: state.subscribe }
	};
});

vi.mock('$lib/stores/auth', async () => {
	const { writable } = await import('svelte/store');
	const state = writable<AuthState>({ authenticated: true, user: { id: 'user-1' } });
	testState.setAuthenticated = state.set;
	return {
		authStore: { subscribe: state.subscribe },
		auth: { login: testState.login },
		currentUser: state
	};
});

vi.mock('$lib/api-client', () => ({
	apiClient: {
		getCliAuthorizationRequest: testState.getRequest,
		decideCliAuthorization: testState.decide
	}
}));

const request = {
	client_name: 'Scout CLI',
	agent_label: 'Claude Code',
	device_label: 'Newsroom laptop',
	site_origin: 'https://scoutpost.ai',
	user_code: 'ABCD-2345',
	status: 'pending' as const,
	expires_at: '2026-07-29T12:10:00.000Z',
	access: 'Read and manage your Scoutpost scouts and reporting data'
};

function pageForCode(userCode: string) {
	return {
		url: new URL(`https://scoutpost.ai/cli/authorize?user_code=${userCode}`),
		params: {},
		route: { id: '/cli/authorize' },
		status: 200,
		error: null,
		data: {},
		form: null
	};
}

beforeEach(() => {
	testState.setAuthenticated?.({ authenticated: true, user: { id: 'user-1' } });
	testState.setPage?.(pageForCode('ABCD-2345'));
	testState.getRequest.mockResolvedValue(request);
	testState.decide.mockResolvedValue({ status: 'approved' });
});

afterEach(() => {
	cleanup();
	sessionStorage.clear();
	vi.clearAllMocks();
});

describe('CLI authorization page', () => {
	it('shows the matching request and waits for an explicit decision', async () => {
		render(CliAuthorizePage);

		expect(await screen.findByText('Claude Code')).toBeInTheDocument();
		expect(screen.getByText('Newsroom laptop')).toBeInTheDocument();
		expect(screen.getByText('ABCD-2345')).toBeInTheDocument();
		expect(screen.getByText(request.access + '.')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Allow connection' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument();
		expect(testState.decide).not.toHaveBeenCalled();
		expect(document.body.textContent).not.toMatch(/cj_[A-Za-z0-9_-]+/);
	});

	it('approves only after Allow and never displays the credential', async () => {
		render(CliAuthorizePage);
		await fireEvent.click(await screen.findByRole('button', { name: 'Allow connection' }));

		await waitFor(() => {
			expect(testState.decide).toHaveBeenCalledWith('ABCD-2345', 'approve');
		});
		expect(await screen.findByText(/return to the terminal/i)).toBeInTheDocument();
		expect(document.body.textContent).not.toMatch(/cj_[A-Za-z0-9_-]+/);
	});

	it('preserves the pending request when a signed-out user starts login', async () => {
		testState.setAuthenticated?.({ authenticated: false, user: null });
		render(CliAuthorizePage);

		await fireEvent.click(screen.getByRole('button', { name: 'Sign in to review' }));
		expect(testState.login).toHaveBeenCalledOnce();
		expect(sessionStorage.getItem('scout:authReturn')).toBe(
			'/cli/authorize?user_code=ABCD-2345'
		);
		expect(testState.decide).not.toHaveBeenCalled();
	});

	it('links to key management when the server enforces the five-key limit', async () => {
		testState.decide.mockRejectedValue(
			new Error('Revoke an existing API key before approving this connection.')
		);
		render(CliAuthorizePage);
		await fireEvent.click(await screen.findByRole('button', { name: 'Allow connection' }));

		expect(await screen.findByRole('link', { name: 'Manage API keys' })).toHaveAttribute(
			'href',
			'/?connect=api'
		);
	});

	it('ignores an older lookup after the page changes to another code', async () => {
		let resolveFirst: ((value: typeof request) => void) | undefined;
		let resolveSecond: ((value: typeof request) => void) | undefined;
		const first = new Promise<typeof request>((resolve) => {
			resolveFirst = resolve;
		});
		const second = new Promise<typeof request>((resolve) => {
			resolveSecond = resolve;
		});
		testState.getRequest.mockImplementation((code: string) =>
			code === 'ABCD-2345' ? first : second
		);

		render(CliAuthorizePage);
		await waitFor(() => expect(testState.getRequest).toHaveBeenCalledWith('ABCD-2345'));
		testState.setPage?.(pageForCode('WXYZ-2345'));
		await waitFor(() => expect(testState.getRequest).toHaveBeenCalledWith('WXYZ-2345'));

		resolveSecond?.({ ...request, user_code: 'WXYZ-2345', agent_label: 'Second Agent' });
		expect(await screen.findByText('Second Agent')).toBeInTheDocument();
		resolveFirst?.({ ...request, agent_label: 'Stale Agent' });

		await waitFor(() => {
			expect(screen.getByText('Second Agent')).toBeInTheDocument();
			expect(screen.queryByText('Stale Agent')).not.toBeInTheDocument();
		});
	});

	it('ignores an older decision after the page changes to another code', async () => {
		let resolveDecision: ((value: { status: string }) => void) | undefined;
		testState.decide.mockReturnValue(
			new Promise((resolve) => {
				resolveDecision = resolve;
			})
		);

		render(CliAuthorizePage);
		await fireEvent.click(await screen.findByRole('button', { name: 'Allow connection' }));
		await waitFor(() => expect(testState.decide).toHaveBeenCalledWith('ABCD-2345', 'approve'));

		testState.setPage?.(pageForCode('WXYZ-2345'));
		await waitFor(() => expect(testState.getRequest).toHaveBeenCalledWith('WXYZ-2345'));
		resolveDecision?.({ status: 'approved' });

		await waitFor(() => {
			expect(screen.queryByText(/connection approved/i)).not.toBeInTheDocument();
		});
	});
});

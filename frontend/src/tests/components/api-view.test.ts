import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ApiView from '$lib/components/views/ApiView.svelte';

const apiMocks = vi.hoisted(() => ({
	createApiKey: vi.fn(),
	listApiKeys: vi.fn(),
	revokeApiKey: vi.fn(),
	alert: vi.fn()
}));

vi.mock('$lib/api-client', () => ({
	apiClient: apiMocks
}));

type ListedKey = {
	key_id: string;
	key_prefix: string;
	name: string;
	created_at: string;
	last_used_at: string | null;
};

const listedKey = (index: number, name = `Key ${index}`): ListedKey => ({
	key_id: `key_${index}`,
	key_prefix: `cj_prefix_${index}`,
	name,
	created_at: '2026-09-01T12:00:00Z',
	last_used_at: null
});

beforeEach(() => {
	apiMocks.createApiKey.mockReset();
	apiMocks.listApiKeys.mockReset();
	apiMocks.revokeApiKey.mockReset();
	apiMocks.alert.mockReset();
	apiMocks.listApiKeys.mockResolvedValue({ keys: [], count: 0 });
	apiMocks.revokeApiKey.mockResolvedValue(undefined);
	vi.stubGlobal('alert', apiMocks.alert);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe('API key creation', () => {
	it('renders a visible Key Name label associated with the required input', async () => {
		render(ApiView);

		const input = await screen.findByLabelText('Key Name');
		expect(input).toHaveAttribute('id', 'api-key-name');
		expect(input).toBeRequired();
		expect(input).toHaveAttribute('aria-required', 'true');
	});

	it('blocks blank names, associates and focuses the error, then clears it after valid input', async () => {
		render(ApiView);
		const input = await screen.findByLabelText('Key Name');
		const submit = screen.getByRole('button', { name: 'Create API Key' });

		await fireEvent.click(submit);
		const error = await screen.findByRole('alert');
		expect(error).toHaveTextContent('Key Name is required');
		expect(input).toHaveAttribute('aria-invalid', 'true');
		expect(input).toHaveAttribute('aria-describedby', error.id);
		expect(input).toHaveFocus();
		expect(apiMocks.createApiKey).not.toHaveBeenCalled();

		await fireEvent.input(input, { target: { value: '   ' } });
		await fireEvent.click(submit);
		expect(apiMocks.createApiKey).not.toHaveBeenCalled();

		await fireEvent.input(input, { target: { value: 'Antigravity Windows QA' } });
		await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
		expect(input).not.toHaveAttribute('aria-invalid');
		expect(input).not.toHaveAttribute('aria-describedby');
	});

	it('trims a successful name, reveals the raw key once, clears the input, and reloads the named row', async () => {
		apiMocks.createApiKey.mockResolvedValue({
			key: 'cj_raw_once',
			key_id: 'key_named',
			key_prefix: 'cj_raw',
			name: 'Antigravity Windows QA',
			created_at: '2026-09-01T12:00:00Z'
		});
		apiMocks.listApiKeys
			.mockResolvedValueOnce({ keys: [], count: 0 })
			.mockResolvedValueOnce({
				keys: [listedKey(1, 'Antigravity Windows QA')],
				count: 1
			});
		render(ApiView);
		const input = await screen.findByLabelText('Key Name');
		await waitFor(() => expect(apiMocks.listApiKeys).toHaveBeenCalledTimes(1));

		await fireEvent.input(input, { target: { value: '  Antigravity Windows QA  ' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Create API Key' }));

		await waitFor(() => {
			expect(apiMocks.createApiKey).toHaveBeenCalledTimes(1);
			expect(apiMocks.createApiKey).toHaveBeenCalledWith('Antigravity Windows QA');
			expect(apiMocks.listApiKeys).toHaveBeenCalledTimes(2);
		});
		expect(input).toHaveValue('');
		expect(screen.getAllByText('cj_raw_once')).toHaveLength(1);
		expect(screen.getByText('Antigravity Windows QA')).toBeInTheDocument();
	});

	it('preserves the typed name and existing alert path when creation fails', async () => {
		apiMocks.createApiKey.mockRejectedValue(new Error('Key limit reached'));
		render(ApiView);
		const input = await screen.findByLabelText('Key Name');

		await fireEvent.input(input, { target: { value: '  Field laptop  ' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Create API Key' }));

		await waitFor(() => expect(apiMocks.alert).toHaveBeenCalledWith('Key limit reached'));
		expect(input).toHaveValue('  Field laptop  ');
		expect(apiMocks.createApiKey).toHaveBeenCalledWith('Field laptop');
	});

	it('keeps the five-key limit and revocation flow intact', async () => {
		const fiveKeys = Array.from({ length: 5 }, (_, index) => listedKey(index));
		apiMocks.listApiKeys
			.mockResolvedValueOnce({ keys: fiveKeys, count: 5 })
			.mockResolvedValueOnce({ keys: fiveKeys.slice(1), count: 4 });
		render(ApiView);

		await screen.findByText('Maximum 5 keys');
		expect(screen.queryByLabelText('Key Name')).not.toBeInTheDocument();
		expect(screen.getAllByTitle('Revoke this key? Any agents using it will stop working.')).toHaveLength(5);

		await fireEvent.click(
			screen.getAllByTitle('Revoke this key? Any agents using it will stop working.')[0]
		);
		await fireEvent.click(screen.getByRole('button', { name: 'Revoke?' }));

		await waitFor(() => {
			expect(apiMocks.revokeApiKey).toHaveBeenCalledWith('key_0');
			expect(apiMocks.listApiKeys).toHaveBeenCalledTimes(2);
		});
	});
});

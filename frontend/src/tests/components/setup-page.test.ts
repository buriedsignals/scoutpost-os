import { render, screen, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import SetupPage from '../../routes/setup/+page.svelte';

afterEach(() => {
	cleanup();
});

describe('setup page', () => {
	it('is Docker-only and does not collect deployment secrets in the browser', () => {
		render(SetupPage);

		expect(
			screen.getByRole('heading', { name: /install scoutpost with docker/i })
		).toBeInTheDocument();
		expect(screen.getByText(/no browser secret collection/i)).toBeInTheDocument();
		expect(
			screen.getAllByText(/ghcr\.io\/buriedsignals\/scoutpost-installer:latest/i).length
		).toBeGreaterThan(0);
		expect(screen.getByRole('link', { name: /download example manifest/i })).toHaveAttribute(
			'href',
			expect.stringContaining('scoutpost-setup.example.json')
		);
		expect(screen.queryByLabelText(/gemini api key/i)).not.toBeInTheDocument();
		expect(screen.queryByLabelText(/supabase access token/i)).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /download docker installer/i })).not.toBeInTheDocument();
		expect(screen.queryByText(/shell fallback/i)).not.toBeInTheDocument();
	});

	it('documents the required and recommended API keys, including Exa as the Beat Scout default', () => {
		render(SetupPage);

		// Each required key is named in the manifest checklist.
		expect(screen.getByText(/Gemini API key/i)).toBeInTheDocument();
		expect(screen.getByText(/Firecrawl API key/i)).toBeInTheDocument();
		expect(screen.getByText(/Apify API token/i)).toBeInTheDocument();
		expect(screen.getByText(/Resend API key/i)).toBeInTheDocument();
		expect(screen.getByText(/MapTiler API key/i)).toBeInTheDocument();
		// "Supabase access token" appears in both the prerequisites callout
		// and the keys list, so allow either or both.
		expect(screen.getAllByText(/Supabase access token/i).length).toBeGreaterThan(0);

		// Exa is named and explained as Beat Scout's default retrieval port.
		expect(screen.getByText(/Exa API key/i)).toBeInTheDocument();
		expect(
			screen.getByText(/Default Beat Scout retrieval port/i)
		).toBeInTheDocument();

		// Exa is recommended (optional with fallback), not strictly required.
		const exaRow = screen.getByText(/Exa API key/i).closest('li');
		expect(exaRow).not.toBeNull();
		expect(exaRow?.textContent ?? '').toMatch(/recommended/i);
	});

	it('shows install, doctor, and update docker commands using the official image', () => {
		render(SetupPage);

		const blocks = screen.getAllByText(/ghcr\.io\/buriedsignals\/scoutpost-installer:latest/i);
		// install, doctor, and update — three docker run blocks.
		expect(blocks.length).toBeGreaterThanOrEqual(3);

		// Each command mounts the manifest read-only into /config — this is the
		// security contract we promise on the page and in docs.
		const readOnlyMounts = screen.getAllByText(
			/scoutpost-setup\.json:\/config\/scoutpost-setup\.json:ro/i
		);
		expect(readOnlyMounts.length).toBeGreaterThanOrEqual(3);
	});
});

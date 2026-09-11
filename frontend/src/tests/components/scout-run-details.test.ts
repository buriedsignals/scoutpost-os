import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import ScoutCard from '$lib/components/workspace/ScoutCard.svelte';
import ScoutFocus from '$lib/components/workspace/ScoutFocus.svelte';
import type { Scout } from '$lib/types/workspace';

afterEach(cleanup);
const scout: Scout = {
 id: 'fixture', name: 'Council monitor', type: 'civic', is_active: true,
 last_run: { started_at: '2026-09-01T09:00:00Z', status: 'success', articles_count: 3, notification_status: 'failed' }
};
for (const [name, renderScout] of [
 ['ScoutCard', (scout: Scout) => render(ScoutCard, { scout })],
 ['ScoutFocus', (scout: Scout) => render(ScoutFocus, { scout })]
] as const) {
 describe(name, () => {
  it('shows saved findings and email failure together', () => {
   renderScout(scout);
   expect(screen.getByText('New findings')).toBeInTheDocument();
   expect(screen.getByText('Email could not be sent.')).toBeInTheDocument();
   expect(screen.queryByText('Run failed')).not.toBeInTheDocument();
  });
  it('shows no-document evidence beside the zero count', () => {
   renderScout({ ...scout, last_run: { ...scout.last_run!, articles_count: 0, notification_status: 'skipped', metadata: { tracked_url_status: [{ status: 'no_new_documents' }] } } });
   expect(screen.getByText('No new documents were found.')).toBeInTheDocument();
   expect(screen.getByText('Email skipped.')).toBeInTheDocument();
  });
 });
}

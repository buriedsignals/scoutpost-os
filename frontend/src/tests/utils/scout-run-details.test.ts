import { describe, expect, it } from 'vitest';
import { getScoutRunDetails, getScoutStatus } from '$lib/utils/scouts';
describe('independent run diagnostics', () => {
 it('preserves extraction success and hides raw errors', () => {
  const scout = { type: 'civic' as const, last_run: { status: 'success', articles_count: 3, notification_status: 'failed', notification_reason: '<script>secret</script>' } };
  expect(getScoutStatus(scout).key).toBe('newFindings');
  expect(getScoutRunDetails(scout)).toEqual([{ kind: 'error', message: 'Email could not be sent.' }]);
 });
 it.each(['pending','sent','delivered','delayed','bounced','suppressed','complained','skipped'])('reports %s', notification_status => {
  expect(getScoutRunDetails({type:'civic',last_run:{notification_status}})).toHaveLength(1);
 });
 it('does not claim delivery means reading or inbox placement', () => {
  expect(getScoutRunDetails({type:'civic',last_run:{notification_status:'delivered'}})[0].message).toBe('Email delivered to recipient server; inbox placement unverified.');
 });
 it('ignores unknown and inapplicable notification states', () => {
  for(const notification_status of [null,undefined,'not_applicable','unknown']) expect(getScoutRunDetails({type:'civic',last_run:{notification_status}})).toEqual([]);
 });
 it('distinguishes no documents from unknown zero findings', () => {
  expect(getScoutRunDetails({type:'civic',last_run:{status:'success',articles_count:0,metadata:{tracked_url_status:[{status:'unchanged'},{status:'no_new_documents'}]}}})[0].message).toBe('No new documents were found.');
  expect(getScoutRunDetails({type:'civic',last_run:{status:'success',articles_count:0}})).toEqual([]);
 });
 it('identifies partial discovery failures', () => {
  expect(getScoutRunDetails({type:'civic',last_run:{status:'success',metadata:{tracked_url_status:[{status:'no_new_documents'},{status:'scrape_failed'}]}}})[0].kind).toBe('warning');
 });
 it('identifies document processing failures', () => {
  expect(getScoutRunDetails({type:'civic',last_run:{status:'error',stage:'extract'}})[0].message).toBe('Document processing failed.');
 });
 it('handles malformed, incomplete and non-Civic metadata conservatively', () => {
  for(const metadata of [null,{}, {tracked_url_status:'bad'}, {tracked_url_status:[null]}]) expect(getScoutRunDetails({type:'civic',last_run:{status:'success',metadata}})).toEqual([]);
  for(const status of ['running','queued']) expect(getScoutRunDetails({type:'civic',last_run:{status,metadata:{tracked_url_status:[{status:'unchanged'}]}}})).toEqual([]);
  expect(getScoutRunDetails({type:'web',last_run:{status:'success',metadata:{tracked_url_status:[{status:'unchanged'}]}}})).toEqual([]);
 });
});

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { MutationAuditTrail } from './MutationAuditTrail';
import { installFakeBackend } from './test/fakeBackend';
afterEach(() => { vi.unstubAllGlobals(); });
test('audit is fetched only when requested and displays explicit non-undo status', async () => {
 const backend=installFakeBackend({'/api/v1/audit': {body:{entries:[{
  sequence:1,previousHash:'',hash:'abc',runId:'a'.repeat(32),time:'2026-10-08T12:00:00Z',
  action:'approved',packId:'conjur',commandId:'secret-delete',risk:'destructive',
  targetLabel:'Variable ID',target:'example/item',effect:'Deletes variable',scope:'single',undo:'not-available',
 }]}}});
 render(<MutationAuditTrail />);
 expect(backend.calls('/api/v1/audit')).toHaveLength(0);
 fireEvent.click(screen.getByRole('button',{name:'View audit trail'}));
 await waitFor(()=>expect(screen.getByText('example/item')).toBeInTheDocument());
 expect(screen.getByText(/Automatic undo unavailable/)).toBeInTheDocument();
 expect(backend.calls('/api/v1/audit')).toHaveLength(1);
 expect(backend.fetch).toHaveBeenCalledWith('/api/v1/audit',expect.objectContaining({credentials:'same-origin'}));
});

test('audit refresh retains prior evidence through loading and failure, then permits a fresh read', async () => {
 const entry = { sequence:1,previousHash:'',hash:'abc',runId:'a'.repeat(32),time:'2026-10-08T12:00:00Z',
  action:'approved',packId:'example',commandId:'change',risk:'change',targetLabel:'Target',target:'original-target',undo:'not-available' };
 const backend = installFakeBackend({ '/api/v1/audit': { body: { entries: [entry] } } });
 render(<MutationAuditTrail />);
 fireEvent.click(screen.getByRole('button', { name: 'View audit trail' }));
 await screen.findByText('original-target');
 let finish!: (reply: { status: number; body: unknown }) => void;
 backend.on({ '/api/v1/audit': () => new Promise((resolve) => { finish = resolve; }) });
 fireEvent.click(screen.getByRole('button', { name: 'Refresh audit' }));
 expect(screen.getByText('original-target')).toBeInTheDocument();
 const refresh = screen.getByRole('button', { name: /Refreshing/ });
 expect(refresh).toBeDisabled();
 expect(refresh).toHaveAttribute('aria-busy', 'true');
 fireEvent.click(refresh);
 expect(backend.calls('/api/v1/audit')).toHaveLength(2);
 await act(async () => finish({ status: 500, body: {} }));
 expect(await screen.findByRole('alert')).toHaveTextContent('Audit trail unavailable');
 expect(screen.getByText('original-target')).toBeInTheDocument();
 expect(screen.getByText(/previously loaded audit entries/i)).toBeInTheDocument();
 backend.on({ '/api/v1/audit': { body: { entries: [{ ...entry, target: 'current-target' }] } } });
 fireEvent.click(screen.getByRole('button', { name: 'Refresh audit' }));
 await screen.findByText('current-target');
 expect(screen.queryByText('original-target')).not.toBeInTheDocument();
 expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('leaving the audit view aborts its pending read without retrying', async () => {
 let finish!: (reply: { body: { entries: [] } }) => void;
 const backend = installFakeBackend({ '/api/v1/audit': () => new Promise((resolve) => { finish = resolve; }) });
 const { unmount } = render(<MutationAuditTrail />);
 fireEvent.click(screen.getByRole('button', { name: 'View audit trail' }));
 const signal = backend.fetch.mock.calls[0][1]?.signal;
 unmount();
 expect(signal?.aborted).toBe(true);
 await act(async () => finish({ body: { entries: [] } }));
 expect(backend.calls('/api/v1/audit')).toHaveLength(1);
});

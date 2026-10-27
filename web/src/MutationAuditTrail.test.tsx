import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

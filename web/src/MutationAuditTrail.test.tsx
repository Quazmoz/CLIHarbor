import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { MutationAuditTrail } from './MutationAuditTrail';
afterEach(() => { vi.unstubAllGlobals(); });
test('audit is fetched only when requested and displays explicit non-undo status', async () => {
 const fetchMock=vi.fn().mockResolvedValue({ok:true,json:async()=>({entries:[{
  sequence:1,previousHash:'',hash:'abc',runId:'a'.repeat(32),time:'2026-10-08T12:00:00Z',
  action:'approved',packId:'conjur',commandId:'secret-delete',risk:'destructive',
  targetLabel:'Variable ID',target:'example/item',effect:'Deletes variable',scope:'single',undo:'not-available',
 }]})});
 vi.stubGlobal('fetch',fetchMock);
 render(<MutationAuditTrail />);
 expect(fetchMock).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'View audit trail'}));
 await waitFor(()=>expect(screen.getByText('example/item')).toBeInTheDocument());
 expect(screen.getByText(/Automatic undo unavailable/)).toBeInTheDocument();
 expect(fetchMock).toHaveBeenCalledWith('/api/v1/audit',expect.objectContaining({credentials:'same-origin'}));
});

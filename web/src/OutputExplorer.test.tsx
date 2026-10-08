import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { OutputExplorer } from './OutputExplorer';
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

afterEach(() => {
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
  vi.restoreAllMocks();
});
describe('OutputExplorer', () => {
  test('formats object and array JSON and copies exact IDs without executing markup', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const stdout = JSON.stringify({ resources: [{ id: 'team:variable:token' }], text: '<img src=x onerror=alert(1)>' });
    render(<OutputExplorer stdout={stdout} stderr="warning" rawOutput={<pre>original stdout</pre>} />);
    expect(screen.getByText('resources[0].id')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy resources[0].id value' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('team:variable:token'));
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText(/stderr is available/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Raw' }));
    expect(screen.getByText('original stdout')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Formatted' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find an ID or value' }), { target: { value: 'token' } });
    expect(screen.getByText('1 of 2 values')).toBeInTheDocument();
  });

  test('falls back to raw for malformed JSON, live output and oversized data', () => {
    const { rerender } = render(<OutputExplorer stdout="{broken" stderr="" rawOutput={<pre>raw text</pre>} />);
    expect(screen.getByRole('button', { name: 'Formatted' })).toBeDisabled();
    expect(screen.getByText('raw text')).toBeInTheDocument();
    rerender(<OutputExplorer stdout={'{"id":"value"}'} stderr="" live rawOutput={<pre>in progress</pre>} />);
    expect(screen.getByRole('button', { name: 'Formatted' })).toBeDisabled();
    rerender(<OutputExplorer stdout={'{"id":"' + 'a'.repeat(140_000) + '"}'} stderr="" rawOutput={<pre>large</pre>} />);
    expect(screen.getByRole('button', { name: 'Formatted' })).toBeDisabled();
  });

  test('supports backend-validated structured fields without parsing raw stdout', () => {
    render(<OutputExplorer stdout="not json" stderr="" structured={{
      status: 'available', renderer: 'cards', fields: [{ key: 'id', label: 'ID', type: 'string', present: true, value: 'safe-id' }],
    }} rawOutput={<pre>unchanged</pre>} />);
    expect(screen.getByText('safe-id')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Raw' }));
    expect(screen.getByText('unchanged')).toBeInTheDocument();
  });
});

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
    render(<OutputExplorer status="exited" exitCode={0} stdout={stdout} stderr="warning" rawOutput={<pre>original stdout</pre>} />);
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
    const { rerender } = render(<OutputExplorer status="exited" exitCode={0} stdout="{broken" stderr="" rawOutput={<pre>raw text</pre>} />);
    expect(screen.getByRole('button', { name: 'Formatted' })).toBeDisabled();
    expect(screen.getByText('raw text')).toBeInTheDocument();
    rerender(<OutputExplorer status="running" stdout={'{"id":"value"}'} stderr="" rawOutput={<pre>in progress</pre>} />);
    expect(screen.getByRole('button', { name: 'Formatted' })).toBeDisabled();
    rerender(<OutputExplorer status="exited" exitCode={0} stdout={'{"id":"' + 'a'.repeat(140_000) + '"}'} stderr="" rawOutput={<pre>large</pre>} />);
    expect(screen.getByRole('button', { name: 'Formatted' })).toBeDisabled();
  });

  test('supports backend-validated structured fields without parsing raw stdout', () => {
    render(<OutputExplorer status="exited" exitCode={0} stdout="not json" stderr="" structured={{
      status: 'available', renderer: 'cards', fields: [{ key: 'id', label: 'ID', type: 'string', present: true, value: 'safe-id' }],
    }} rawOutput={<pre>unchanged</pre>} />);
    expect(screen.getByText('safe-id')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Raw' }));
    expect(screen.getByText('unchanged')).toBeInTheDocument();
  });

  test.each(['invalid', 'unavailable'] as const)('honors %s backend parsing instead of re-parsing stdout', (status) => {
    render(<OutputExplorer status="exited" exitCode={0} stdout={'{"id":"first","id":"second"}'} stderr=""
      structured={{ status, renderer: 'cards', error: 'duplicate_key' }} rawOutput={<pre>original evidence</pre>} />);
    expect(screen.getByRole('button', { name: 'Formatted' })).toBeDisabled();
    expect(screen.getByText('original evidence')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Copy .* value/ })).not.toBeInTheDocument();
  });

  test('requires a successful exit even when structured fields are supplied', () => {
    const props = { stdout: '{"id":"value"}', stderr: '', structured: {
      status: 'available' as const, renderer: 'cards' as const,
      fields: [{ key: 'id', label: 'ID', type: 'string' as const, present: true, value: 'value' }],
    }, rawOutput: <pre>original evidence</pre> };
    const { rerender } = render(<OutputExplorer {...props} status="exited" />);
    expect(screen.getByRole('button', { name: 'Formatted' })).toBeDisabled();
    rerender(<OutputExplorer {...props} status="failed" exitCode={0} />);
    expect(screen.getByRole('button', { name: 'Formatted' })).toBeDisabled();
    rerender(<OutputExplorer {...props} status="exited" exitCode={0} />);
    expect(screen.getByText('value')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Formatted' })).toBeEnabled();
  });
});

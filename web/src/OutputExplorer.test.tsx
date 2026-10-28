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
  test.each(['[]', '{}', '{"resources":[]}'])('distinguishes empty %s from a search with no matches and preserves raw output', (stdout) => {
    render(<OutputExplorer status="exited" exitCode={0} stdout={stdout} stderr="warning" rawOutput={<pre>{stdout}</pre>} />);
    expect(screen.getByText('Command completed successfully. No values to display.')).toHaveAttribute('role', 'status');
    expect(screen.queryByText(/No values match/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find an ID or value' }), { target: { value: 'anything' } });
    expect(screen.getByText('Command completed successfully. No values to display.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Copy/ })).not.toBeInTheDocument();
    expect(screen.getByText(/stderr is available/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Raw' }));
    expect(screen.getByText(stdout)).toBeInTheDocument();
  });

  test('reports a filter miss only when values exist and restores values after clearing it', () => {
    render(<OutputExplorer status="exited" exitCode={0} stdout={'{"id":"resource-id","count":0,"enabled":false,"missing":null,"text":""}'} stderr="" rawOutput={<pre>original</pre>} />);
    expect(screen.getByText('5 of 5 values')).toBeInTheDocument();
    const search = screen.getByRole('searchbox', { name: 'Find an ID or value' });
    fireEvent.change(search, { target: { value: 'no-match' } });
    expect(screen.getByText('No values match. Try a different search or switch to Raw.')).toBeInTheDocument();
    expect(screen.queryByText(/No values to display/)).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: '   ' } });
    expect(screen.getByText('5 of 5 values')).toBeInTheDocument();
    expect(screen.getByText('resource-id')).toBeInTheDocument();
    expect(screen.queryByText(/No values match/)).not.toBeInTheDocument();
  });

  test.each([
    JSON.stringify({ value: 'a'.repeat(8193) }),
    '{"a":{"b":{"c":{"d":{"e":{"f":{"g":{"h":"deep"}}}}}}}}',
  ])('keeps a preview with omitted values distinct from an empty result', (stdout) => {
    render(<OutputExplorer status="exited" exitCode={0} stdout={stdout} stderr="" rawOutput={<pre>{stdout}</pre>} />);
    expect(screen.getByText(/No values fit within the preview limits/)).toBeInTheDocument();
    expect(screen.getByText(/Large or deeply nested result/)).toBeInTheDocument();
    expect(screen.queryByText(/No values to display|No values match/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Raw' }));
    expect(screen.getByText(stdout)).toBeInTheDocument();
  });

  test('reports a confirmed silent success while preserving raw stream boundaries', () => {
    render(<OutputExplorer status="exited" exitCode={0} stdout="" stderr="" rawOutput={<pre>No stdout retained.</pre>} />);
    expect(screen.getByText('Command completed successfully. No stdout or stderr was returned.')).toHaveAttribute('role', 'status');
    expect(screen.getByText('No stdout retained.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Formatted' })).toBeDisabled();
  });

  test.each([
    { status: 'running' as const }, { status: 'exited' as const }, { status: 'exited' as const, exitCode: 1 },
    { status: 'failed' as const, exitCode: 0 }, { status: 'cancelled' as const }, { status: 'timed-out' as const },
    { status: 'exited' as const, exitCode: 0, stderr: 'warning' },
    { status: 'exited' as const, exitCode: 0, stdout: ' \n' },
  ])('never infers silent success from incomplete, unsuccessful or nonempty evidence: %j', (props) => {
    render(<OutputExplorer stdout="" stderr="" {...props} rawOutput={<pre>original evidence</pre>} />);
    expect(screen.queryByText(/Command completed successfully/)).not.toBeInTheDocument();
    expect(screen.getByText('original evidence')).toBeInTheDocument();
  });

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
    expect(screen.queryByRole('button', { name: /Export/ })).not.toBeInTheDocument();
  });

  test('exports only successful complete previews and disables empty filtered exports', () => {
    const props = { stdout: '{"id":"metadata"}', stderr: '', rawOutput: <pre>original</pre> };
    const view = render(<OutputExplorer {...props} status="running" />);
    expect(screen.queryByRole('button', { name: /Export/ })).not.toBeInTheDocument();
    view.rerender(<OutputExplorer {...props} status="exited" exitCode={7} />);
    expect(screen.queryByRole('button', { name: /Export/ })).not.toBeInTheDocument();
    view.rerender(<OutputExplorer {...props} status="exited" exitCode={0} />);
    expect(screen.getByRole('button', { name: 'Export JSON' })).toBeEnabled();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find an ID or value' }), { target: { value: 'missing' } });
    expect(screen.getByRole('button', { name: 'Export JSON' })).toBeDisabled();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find an ID or value' }), { target: { value: '' } });
    view.rerender(<OutputExplorer {...props} stdout={JSON.stringify({ id: 'metadata', large: 'a'.repeat(8193) })} status="exited" exitCode={0} />);
    expect(screen.getByText('metadata')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export JSON' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Raw' }));
    expect(screen.queryByRole('button', { name: /Export/ })).not.toBeInTheDocument();
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

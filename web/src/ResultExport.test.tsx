import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ResultExport } from './ResultExport';

const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, descriptor] of [['createObjectURL', originalCreate], ['revokeObjectURL', originalRevoke]] as const) {
    if (descriptor) Object.defineProperty(URL, key, descriptor);
    else Reflect.deleteProperty(URL, key);
  }
});

function downloadHarness() {
  const blobs: Blob[] = [];
  const create = vi.fn((blob: Blob) => { blobs.push(blob); return 'blob:local-result'; });
  const revoke = vi.fn();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const cleanups: (() => void)[] = [];
  const nativeTimeout = window.setTimeout.bind(window);
  vi.spyOn(window, 'setTimeout').mockImplementation((handler, timeout, ...args) => {
    if (timeout === 1000 && typeof handler === 'function') {
      cleanups.push(() => handler(...args));
      return -1;
    }
    return nativeTimeout(handler, timeout, ...args);
  });
  return { blobs, create, revoke, click, cleanup: () => cleanups.splice(0).forEach((callback) => callback()) };
}

function read(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsText(blob);
  });
}

describe('local result exports', () => {
  test('downloads normalized display values with run provenance and cleans up its URL', async () => {
    const { blobs, click, revoke, cleanup } = downloadHarness();
    const fields = [{ field: 'id', value: '<img src=x> ü' }, { field: 'missing', value: null }, { field: 'empty', value: '' }];
    const runId = 'a'.repeat(32);
    render(<ResultExport fields={fields} runId={runId} />);
    fireEvent.click(screen.getByRole('button', { name: 'Export JSON' }));
    expect(JSON.parse(await read(blobs[0]))).toEqual({ schemaVersion: 'cliharbor.result-fields/v1', runId, fields });
    expect(blobs[0].type).toBe('application/json;charset=utf-8');
    const link = click.mock.instances[0] as HTMLAnchorElement;
    expect(link.download).toBe('cliharbor-result-' + runId + '.json');
    expect(link.isConnected).toBe(false);
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('JSON download started for 3 displayed fields.');
    expect(revoke).not.toHaveBeenCalled();
    cleanup();
    expect(revoke).toHaveBeenCalledWith('blob:local-result');
  });

  test('escapes CSV quotes, separators and Unicode while neutralizing formula cells', async () => {
    const { blobs } = downloadHarness();
    render(<ResultExport fields={[
      { field: '=HYPERLINK("x")', value: '  +SUM(1,2)' },
      { field: 'normal', value: 'quotes " and, comma\nü' },
      { field: '\tformula', value: '-1' },
      { field: 'missing', value: null },
      { field: 'empty', value: '' },
      { field: 'at', value: '@SUM(1)' },
    ]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    const content = await read(blobs[0]);
    expect(content).toContain('"Run ID","Field","Present","Value"\r\n');
    expect(content).toContain('"\'=HYPERLINK(""x"")","true","\'  +SUM(1,2)"');
    expect(content).toContain('"normal","true","quotes "" and, comma\nü"');
    expect(content).toContain('"\'\tformula","true","\'-1"');
    expect(content).toContain('"missing","false",""');
    expect(content).toContain('"empty","true",""');
    expect(content).toContain('"at","true","\'@SUM(1)"');
    expect(blobs[0].type).toBe('text/csv;charset=utf-8');
  });

  test('blocks empty or limited exports and recovers from browser download failures', () => {
    const { create, click, revoke, cleanup } = downloadHarness();
    const fields = [{ field: 'id', value: 'metadata' }];
    const view = render(<ResultExport fields={[]} />);
    expect(screen.getByRole('button', { name: 'Export JSON' })).toBeDisabled();
    view.rerender(<ResultExport fields={fields} disabled />);
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(create).not.toHaveBeenCalled();
    view.rerender(<ResultExport fields={fields} runId="../../unsafe" />);
    click.mockImplementationOnce(() => { throw new Error('private browser failure'); });
    fireEvent.click(screen.getByRole('button', { name: 'Export JSON' }));
    expect(screen.getByRole('status')).toHaveTextContent('Your browser could not start the download.');
    expect(document.querySelector('a')).toBeNull();
    expect(click.mock.instances[0]).toHaveProperty('download', 'cliharbor-result.json');
    cleanup();
    expect(revoke).toHaveBeenCalledOnce();
    create.mockImplementationOnce(() => { throw new Error('object URL blocked'); });
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(screen.queryByText(/download started/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(screen.getByRole('status')).toHaveTextContent('CSV download started');
  });
});

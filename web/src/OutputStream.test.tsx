import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { OutputStream } from './OutputStream';
import { OutputExplorer } from './OutputExplorer';

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
afterEach(() => {
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

test('searches literal lines independently, preserves line numbers and copies the complete exact stream', async () => {
  const text = 'prefix\r\nERROR [a.*] café <img src=x onerror=alert(1)>\r\nlast\n';
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const storage = vi.spyOn(Storage.prototype, 'setItem');
  render(<OutputExplorer runId={'a'.repeat(32)} stdout={text} stderr="other stream" status="failed" />);
  const stdout = screen.getByLabelText('stdout output');
  expect(stdout.textContent).toBe(text);
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search stdout' }), { target: { value: '[A.*]' } });
  expect(screen.getByText(/1 matching line in stdout/)).toBeInTheDocument();
  expect(stdout.querySelector('.output-line-number')).toHaveTextContent('2');
  expect(stdout).not.toHaveTextContent('prefix');
  expect(document.querySelector('img')).toBeNull();
  expect(screen.getByLabelText('stderr output')).toHaveTextContent('other stream');
  fireEvent.click(screen.getByRole('button', { name: 'Copy stdout' }));
  await screen.findByText('Copied stdout.');
  expect(writeText).toHaveBeenCalledExactlyOnceWith(text);
  fireEvent.click(screen.getByRole('button', { name: 'Wrap stdout lines' }));
  expect(stdout).toHaveClass('output-stream-nowrap');
  expect(screen.getByRole('button', { name: 'Wrap stdout lines' })).toHaveAttribute('aria-pressed', 'false');
  fireEvent.click(screen.getByRole('button', { name: 'Clear stdout search' }));
  expect(screen.getByRole('searchbox', { name: 'Search stdout' })).toHaveFocus();
  expect(stdout.textContent).toBe(text);
  expect(storage).not.toHaveBeenCalled();
});

test('bounds displayed search results, counts all matching lines and resets inspection for another run', () => {
  const text = Array.from({ length: 401 }, (_, i) => 'match ' + i).join('\n');
  const view = render(<OutputExplorer runId={'a'.repeat(32)} stdout={text} stderr="" status="running" />);
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search stdout' }), { target: { value: 'match' } });
  expect(screen.getByText(/401 matching lines in stdout · first 200 shown/)).toBeInTheDocument();
  expect(document.querySelectorAll('.output-search-line')).toHaveLength(200);
  expect(screen.getByRole('button', { name: 'Follow stdout' })).toBeDisabled();
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search stdout' }), { target: { value: 'missing' } });
  expect(screen.getByText('No stdout lines match.')).toBeInTheDocument();
  expect(screen.getByText(/0 matching lines in stdout/)).toBeInTheDocument();
  view.rerender(<OutputExplorer runId={'b'.repeat(32)} stdout="new evidence" stderr="" status="running" />);
  expect(screen.getByRole('searchbox', { name: 'Search stdout' })).toHaveValue('');
  expect(screen.getByLabelText('stdout output')).toHaveTextContent('new evidence');
  expect(screen.getByRole('button', { name: 'Copy stderr' })).toBeDisabled();
});

test('follows live output until the operator scrolls away, with explicit pause and resume', () => {
  const view = render(<OutputStream name="stdout" text="first" live />);
  const pre = screen.getByLabelText('stdout output');
  Object.defineProperties(pre, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { value: 100 } });
  view.rerender(<OutputStream name="stdout" text="first\nsecond" live />);
  expect(pre.scrollTop).toBe(1000);
  pre.scrollTop = 50;
  fireEvent.scroll(pre);
  expect(screen.getByRole('button', { name: 'Follow stdout' })).toHaveAttribute('aria-pressed', 'false');
  view.rerender(<OutputStream name="stdout" text="first\nsecond\nthird" live />);
  expect(pre.scrollTop).toBe(50);
  fireEvent.click(screen.getByRole('button', { name: 'Follow stdout' }));
  expect(pre.scrollTop).toBe(1000);
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search stdout' }), { target: { value: 'second' } });
  expect(pre.scrollTop).toBe(0);
  view.rerender(<OutputStream name="stdout" text="first\nsecond\nthird\nfourth" live />);
  expect(pre.scrollTop).toBe(0);
  fireEvent.click(screen.getByRole('button', { name: 'Clear stdout search' }));
  expect(pre.scrollTop).toBe(1000);
  view.rerender(<OutputStream name="stdout" text="complete" live={false} />);
  expect(screen.queryByRole('button', { name: 'Follow stdout' })).not.toBeInTheDocument();
});

test('handles clipboard denial and ignores copy feedback for superseded output', async () => {
  let finish!: () => void;
  const writeText = vi.fn().mockRejectedValueOnce(new Error('denied')).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const view = render(<OutputStream name="stderr" text="original" live />);
  fireEvent.click(screen.getByRole('button', { name: 'Copy stderr' }));
  await screen.findByText(/Could not copy stderr/);
  fireEvent.click(screen.getByRole('button', { name: 'Copy stderr' }));
  view.rerender(<OutputStream name="stderr" text="new output" live />);
  await act(async () => finish());
  await waitFor(() => expect(screen.queryByText(/Copied stderr|Could not copy stderr/)).not.toBeInTheDocument());
});

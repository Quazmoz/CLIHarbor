import { render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { RunComparison } from './RunComparison';
import type { RunSnapshot } from './api/runs';

function snapshot(id: string, stdout = '', stderr = '', overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  const encode = (value: string) => btoa(Array.from(new TextEncoder().encode(value), (byte) => String.fromCharCode(byte)).join(''));
  return {
    runId: id.repeat(32), packId: 'fixture', commandId: 'inspect', toolId: 'fixture',
    toolVersion: '1.2.3', status: 'exited', exitCode: 0, ...overrides,
    events: [
      { sequence: 1, type: 'stdout.chunk', timestamp: '2026-10-28T10:00:00Z', dataBase64: encode(stdout) },
      { sequence: 2, type: 'stderr.chunk', timestamp: '2026-10-28T10:00:00Z', dataBase64: encode(stderr) },
    ],
  };
}

describe('recorded run comparison', () => {
  test('keeps streams separate, preserves failed outcomes and renders hostile Unicode text inertly', () => {
    const baseline = snapshot('a', 'same stdout', 'before diagnostic');
    const selected = snapshot('b', 'same stdout', '<img id="comparison-pwn" src=x onerror=alert(1)> ü', { exitCode: 7, toolVersion: '2.0.0' });
    render(<RunComparison baseline={baseline} selected={selected} />);
    expect(screen.getByText('stdout · Same text').closest('details')).not.toHaveAttribute('open');
    expect(screen.getByText('stderr · Text differs').closest('details')).toHaveAttribute('open');
    expect(screen.getByText('Selected · Failed · exit 7')).toBeInTheDocument();
    expect(screen.getByText('fixture · Version 2.0.0')).toBeInTheDocument();
    expect(screen.getByText(selected.runId)).toBeInTheDocument();
    expect(screen.getByText('<img id="comparison-pwn" src=x onerror=alert(1)> ü')).toBeInTheDocument();
    expect(document.querySelector('#comparison-pwn')).toBeNull();
    expect(within(screen.getByRole('region', { name: 'Baseline stderr' })).getByText('before diagnostic')).toBeInTheDocument();
    expect(screen.getByText(/matching output does not prove unchanged service state/)).toBeInTheDocument();
  });

  test('labels positional differences, including a trailing empty line, without hiding them behind color', () => {
    render(<RunComparison baseline={snapshot('a', 'same\nold\n')} selected={snapshot('b', 'same\nnew\nextra')} />);
    const baseline = screen.getByRole('list', { name: 'Baseline stdout lines' });
    const selected = screen.getByRole('list', { name: 'Selected stdout lines' });
    expect(within(baseline).getByLabelText('Line 1, same')).toHaveTextContent('1 =');
    expect(within(selected).getByLabelText('Line 2, differs')).toHaveTextContent('2 ≠');
    expect(within(baseline).getByLabelText('Line 3, differs')).toBeInTheDocument();
    expect(within(baseline).getByText('(empty line)')).toBeInTheDocument();
    expect(within(selected).getAllByRole('listitem')).toHaveLength(3);
  });

  test('uses full retained text for equality even when the displayed character or line preview is limited', () => {
    const view = render(<RunComparison baseline={snapshot('a', 'x'.repeat(20_000) + 'hidden-before')} selected={snapshot('b', 'x'.repeat(20_000) + 'hidden-after')} />);
    expect(screen.getByText('stdout · Text differs')).toBeInTheDocument();
    expect(screen.getByText(/Comparison preview limited/)).toBeInTheDocument();
    expect(screen.queryByText(/hidden-before|hidden-after/)).not.toBeInTheDocument();
    view.rerender(<RunComparison baseline={snapshot('a', Array(201).fill('line').join('\n'))} selected={snapshot('b', 'short')} />);
    expect(within(screen.getByRole('list', { name: 'Baseline stdout lines' })).getAllByRole('listitem')).toHaveLength(200);
    expect(screen.getByText(/Comparison preview limited/)).toBeInTheDocument();
  });

  test('compares raw diagnostics without formatting backend-rejected JSON', () => {
    render(<RunComparison baseline={snapshot('a', '{"id":"first","id":"second"}', '', {
      structured: { status: 'invalid', renderer: 'cards', error: 'duplicate_key' },
    })} selected={snapshot('b', '{"id":"second"}')} />);
    expect(screen.getByText('{"id":"first","id":"second"}')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Formatted|Export|Copy/ })).not.toBeInTheDocument();
    expect(screen.getByText('stderr · Same text')).toBeInTheDocument();
  });

  test.each([
    { overrides: { packId: 'other' }, message: /Choose a run of fixture\/inspect/ },
    { overrides: { commandId: 'other' }, message: /Choose a run of fixture\/inspect/ },
    { overrides: { toolId: 'other' }, message: /Choose a run of fixture\/inspect/ },
    { overrides: { status: 'running' as const, exitCode: undefined }, message: /Wait for the selected run to finish/ },
    { overrides: { runId: 'a'.repeat(32) }, message: /Baseline pinned. Open another run/ },
  ])('does not compare incompatible, unfinished or identical run selections: $overrides', ({ overrides, message }) => {
    render(<RunComparison baseline={snapshot('a', 'before')} selected={snapshot('b', 'after', '', overrides)} />);
    expect(screen.getByRole('status')).toHaveTextContent(message);
    expect(screen.queryByText(/stdout ·/)).not.toBeInTheDocument();
  });
});

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { Task } from './api/tasks';
import type { ToolDiagnostic } from './api/tools';
import { ExecutionPreflight } from './ExecutionPreflight';
import { ToolExplorer } from './ToolExplorer';

const readTask: Task = { packId: 'p', packName: 'Pack', commandId: 'list', name: 'List', toolId: 'cli', risk: 'read', inputs: [] };
const changeTask: Task = {
  ...readTask, commandId: 'grant', name: 'Grant', risk: 'change', requiresAuth: true,
  impact: { targetInput: 'id', targetLabel: 'ID', effect: 'Grants access.', scope: 'single' },
};
const readyTool: ToolDiagnostic = { packId: 'p', packName: 'Pack', packVersion: '1.0.0', toolId: 'cli', status: 'ready', version: '2.0.0' };

function statusOf(title: string): string {
  const row = screen.getByText(title).closest('li');
  return row?.querySelector('.preflight-status')?.textContent ?? '';
}

describe('ExecutionPreflight', () => {
  test('reports readiness from runtime state without claiming sign-in', () => {
    const props = { task: readTask, tool: readyTool, validated: false, validating: false, validationFailed: false, approvalReady: false };
    const { rerender } = render(<ExecutionPreflight {...props} />);
    expect(statusOf('Executable found')).toBe('Passed');
    expect(statusOf('Input validation')).toBe('Pending');
    expect(statusOf('Execution readiness')).toBe('Ready');
    const details = screen.getByText('Technical details').closest('details');
    expect(details).not.toHaveAttribute('open');
    if (!details) throw new Error('Missing technical details');
    fireEvent.click(within(details).getByText('Technical details'));
    expect(details).toHaveAttribute('open');
    expect(within(details).getByText('Direct (no shell, no elevation)')).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Execution Summary' })).not.toBeInTheDocument();

    rerender(<ExecutionPreflight {...props} validated />);
    expect(statusOf('Input validation')).toBe('Passed');

    rerender(<ExecutionPreflight {...props} task={changeTask} />);
    expect(statusOf('Vendor session')).toBe('Sign-in required');
    expect(statusOf('Execution readiness')).toBe('Requires approval');
    rerender(<ExecutionPreflight {...props} task={changeTask} approvalReady />);
    expect(statusOf('Execution readiness')).toBe('Approved');

    rerender(<ExecutionPreflight {...props} tool={{ ...readyTool, status: 'missing', version: undefined }} />);
    expect(statusOf('Executable found')).toBe('Missing');
    expect(statusOf('Execution readiness')).toBe('Blocked');
  });
});

describe('ToolExplorer', () => {
  test('filters by tools with tasks and routes tools without tasks to setup', () => {
    const onSelectTool = vi.fn();
    const onOpenTools = vi.fn();
    const missing: ToolDiagnostic = { ...readyTool, packId: 'k', packName: 'Kube', toolId: 'kubectl', status: 'missing', version: undefined };
    render(<ToolExplorer tools={[readyTool, missing]} tasks={[readTask]} selectedToolKey="" onSelectTool={onSelectTool} onOpenTools={onOpenTools} />);
    fireEvent.click(screen.getByText('Tool Explorer', { selector: 'summary' }));

    expect(screen.getByRole('button', { name: /^All tools/ })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: /^Pack/ }));
    expect(onSelectTool).toHaveBeenCalledWith('p/cli');

    const kube = screen.getByRole('button', { name: /^Kube/ });
    expect(within(kube).getByText('Not installed')).toBeInTheDocument();
    fireEvent.click(kube);
    expect(onOpenTools).toHaveBeenCalled();

    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  });
});

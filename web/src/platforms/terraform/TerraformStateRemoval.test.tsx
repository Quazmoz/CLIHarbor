import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TerraformStateRemoval } from './TerraformStateRemoval';
import { installFakeBackend } from '../../test/fakeBackend';

const TEST_CSRF_TOKEN = 'test-csrf-token';

afterEach(() => { vi.unstubAllGlobals(); });

const PREVIEW_ID = 'p'.repeat(43);
const address = 'aws_instance.web["blue"]';
const preview = {
  previewId: PREVIEW_ID, projectId: 'project-1', stateId: 'state-a', stateName: 'terraform.tfstate',
  addresses: [address], serial: 7, terraformVersion: '1.9.8', expiresAt: '2026-10-23T12:05:00Z',
};
const removed = {
  outcome: 'removed', projectId: 'project-1', stateId: 'state-a', stateName: 'terraform.tfstate', removed: [address],
  serial: 8, backup: 'terraform.tfstate.cliharbor-20261023T120000Z-ab12cd34.backup',
  terraformBackup: 'terraform.tfstate.terraform-20261023T120000Z-ab12cd34.backup', completedAt: '2026-10-23T12:01:00Z',
};

function renderRemoval(overrides: Partial<Parameters<typeof TerraformStateRemoval>[0]> = {}) {
  const onStateChanged = vi.fn();
  const props = {
    projectId: 'project-1', projectName: 'infra', stateId: 'state-a', stateName: 'terraform.tfstate',
    address, ready: true, csrfToken: TEST_CSRF_TOKEN, onStateChanged, ...overrides,
  };
  const view = render(<TerraformStateRemoval {...props} />);
  return { ...view, props, onStateChanged };
}

describe('TerraformStateRemoval', () => {
  test('shows dry-run and removal progress until completion and blocks repeat clicks', async () => {
    let finishPreview!: (value: { body: typeof preview }) => void;
    let finishExecute!: (value: { body: typeof removed }) => void;
    const previewing = new Promise<{ body: typeof preview }>((resolve) => { finishPreview = resolve; });
    const executing = new Promise<{ body: typeof removed }>((resolve) => { finishExecute = resolve; });
    const backend = installFakeBackend({
      'POST /api/v1/terraform/state-removal/preview': () => previewing,
      'POST /api/v1/terraform/state-removal/execute': () => executing,
    });
    const { container } = renderRemoval();
    fireEvent.click(screen.getByRole('button', { name: 'Preview removal' }));
    const dryRun = screen.getByRole('button', { name: 'Running dry run…' });
    expect(dryRun).toBeDisabled();
    expect(dryRun).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Checking state removal…')).toBeInTheDocument();
    fireEvent.click(dryRun);
    expect(backend.calls('POST /api/v1/terraform/state-removal/preview')).toHaveLength(1);
    await act(async () => finishPreview({ body: preview }));
    fireEvent.change(screen.getByRole('textbox', { name: /to confirm/ }), { target: { value: 'terraform.tfstate' } });
    fireEvent.click(screen.getByRole('button', { name: 'Forget from state' }));
    const removing = screen.getByRole('button', { name: 'Removing from state…' });
    expect(removing).toBeDisabled();
    expect(removing).toHaveAttribute('aria-busy', 'true');
    expect(container.querySelector('.working-status .work-spinner')).toBeInTheDocument();
    fireEvent.click(removing);
    expect(backend.calls('POST /api/v1/terraform/state-removal/execute')).toHaveLength(1);
    await act(async () => finishExecute({ body: removed }));
    expect(container.querySelector('.working-status')).toBeEmptyDOMElement();
    expect(screen.getByRole('button', { name: 'Preview removal' })).toBeEnabled();
  });

  test('previews, requires typed confirmation, executes once and reports verified backups', async () => {
    const backend = installFakeBackend({
      'POST /api/v1/terraform/state-removal/preview': { body: preview },
      'POST /api/v1/terraform/state-removal/execute': { body: removed },
    });
    const { onStateChanged } = renderRemoval();
    expect(screen.getByText(/not/, { selector: 'strong' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Preview removal' }));
    expect(await screen.findByRole('heading', { name: /Dry run passed/ })).toBeInTheDocument();
    expect(backend.bodies('POST /api/v1/terraform/state-removal/preview')).toEqual([{ project: 'project-1', state: 'state-a', addresses: [address] }]);
    expect(backend.calls('POST /api/v1/terraform/state-removal/preview')[0].headers.get('X-CLIHarbor-CSRF')).toBe(TEST_CSRF_TOKEN);

    const forget = screen.getByRole('button', { name: 'Forget from state' });
    expect(forget).toBeDisabled();
    const input = screen.getByRole('textbox', { name: /to confirm/ });
    fireEvent.change(input, { target: { value: 'terraform.tfstat' } });
    expect(forget).toBeDisabled();
    fireEvent.change(input, { target: { value: 'terraform.tfstate' } });
    expect(forget).toBeEnabled();
    fireEvent.click(forget);

    expect(await screen.findByText('Removed from state:')).toBeInTheDocument();
    expect(screen.getByText(removed.backup)).toBeInTheDocument();
    expect(backend.bodies('POST /api/v1/terraform/state-removal/execute')).toEqual([{ previewId: PREVIEW_ID, confirm: 'terraform.tfstate' }]);
    expect(onStateChanged).toHaveBeenCalledTimes(1);
    // The one-use preview is gone; a second removal needs a fresh dry run.
    expect(screen.queryByRole('button', { name: 'Forget from state' })).not.toBeInTheDocument();
  });

  test('an unverified outcome is an alert that says not to retry and names both backups', async () => {
    installFakeBackend({
      'POST /api/v1/terraform/state-removal/preview': { body: preview },
      'POST /api/v1/terraform/state-removal/execute': { body: { ...removed, outcome: 'unverified', removed: [], problem: 'Terraform did not finish cleanly and the state file changed.' } },
    });
    const { onStateChanged } = renderRemoval();
    fireEvent.click(screen.getByRole('button', { name: 'Preview removal' }));
    fireEvent.change(await screen.findByRole('textbox', { name: /to confirm/ }), { target: { value: 'terraform.tfstate' } });
    fireEvent.click(screen.getByRole('button', { name: 'Forget from state' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Result not verified.');
    expect(alert).toHaveTextContent('Do not retry.');
    expect(alert).toHaveTextContent(removed.backup);
    expect(alert).toHaveTextContent(removed.terraformBackup);
    expect(onStateChanged).toHaveBeenCalledTimes(1);
  });

  test('a stale preview is explained and the state is not reloaded', async () => {
    installFakeBackend({
      'POST /api/v1/terraform/state-removal/preview': { body: preview },
      'POST /api/v1/terraform/state-removal/execute': {
        status: 409,
        body: { error: { code: 'approval_required', category: 'policy', message: 'This change requires a fresh explicit approval.', retryable: false } },
      },
    });
    const { onStateChanged } = renderRemoval();
    fireEvent.click(screen.getByRole('button', { name: 'Preview removal' }));
    fireEvent.change(await screen.findByRole('textbox', { name: /to confirm/ }), { target: { value: 'terraform.tfstate' } });
    fireEvent.click(screen.getByRole('button', { name: 'Forget from state' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Preview the removal again/);
    expect(onStateChanged).not.toHaveBeenCalled();
  });

  test('a locked state is reported as refused and unchanged', async () => {
    installFakeBackend({
      'POST /api/v1/terraform/state-removal/preview': {
        status: 409,
        body: { error: { code: 'execution_failed', category: 'execution', message: 'x', retryable: false } },
      },
    });
    renderRemoval();
    fireEvent.click(screen.getByRole('button', { name: 'Preview removal' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/was not changed/);
  });

  test('changing the selected address discards the preview and its confirmation', async () => {
    installFakeBackend({ 'POST /api/v1/terraform/state-removal/preview': { body: preview } });
    const { rerender, props } = renderRemoval();
    fireEvent.click(screen.getByRole('button', { name: 'Preview removal' }));
    fireEvent.change(await screen.findByRole('textbox', { name: /to confirm/ }), { target: { value: 'terraform.tfstate' } });
    rerender(<TerraformStateRemoval {...props} address="aws_instance.other" />);
    expect(screen.queryByRole('button', { name: 'Forget from state' })).not.toBeInTheDocument();
    rerender(<TerraformStateRemoval {...props} />);
    // Going back does not resurrect the old one-use preview.
    expect(screen.queryByRole('button', { name: 'Forget from state' })).not.toBeInTheDocument();
  });

  test('a dry run still in flight is aborted when the selection changes', async () => {
    let seenSignal: AbortSignal | undefined;
    installFakeBackend({
      'POST /api/v1/terraform/state-removal/preview': () => new Promise(() => { /* never answers */ }),
    });
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      seenSignal = init?.signal ?? undefined;
      return originalFetch(input, init);
    }));
    const { rerender, props } = renderRemoval();
    fireEvent.click(screen.getByRole('button', { name: 'Preview removal' }));
    expect(screen.getByRole('button', { name: 'Running dry run…' })).toBeDisabled();
    await act(async () => rerender(<TerraformStateRemoval {...props} address="aws_instance.other" />));
    await waitFor(() => expect(seenSignal?.aborted).toBe(true));
  });

  test('preview is unavailable without a ready CLI, a session token, or a selected address', () => {
    const { rerender, props } = renderRemoval({ ready: false });
    expect(screen.getByRole('button', { name: 'Preview removal' })).toBeDisabled();
    rerender(<TerraformStateRemoval {...props} ready csrfToken={undefined} />);
    expect(screen.getByRole('button', { name: 'Preview removal' })).toBeDisabled();
    rerender(<TerraformStateRemoval {...props} ready address="" />);
    expect(screen.getByRole('button', { name: 'Preview removal' })).toBeDisabled();
    expect(screen.getByText(/Select one exact resource/)).toBeInTheDocument();
  });

  test('a preview for different addresses than requested is rejected client-side', async () => {
    installFakeBackend({ 'POST /api/v1/terraform/state-removal/preview': { body: { ...preview, addresses: [address, 'aws_instance.extra'] } } });
    renderRemoval();
    fireEvent.click(screen.getByRole('button', { name: 'Preview removal' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Forget from state' })).not.toBeInTheDocument();
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { TerraformWorkspace } from './TerraformWorkspace';
import type { Platform } from '../../api/platforms';

const platform: Platform = {
  id: 'terraform', name: 'HashiCorp Terraform', summary: 'Local state',
  packId: 'terraform-cli', toolId: 'terraform', ready: true,
  features: [{ id: 'tasks', name: 'Offline CLI help' }],
};
const props = {
  platform, tasks: [],
  tool: { packId: 'terraform-cli', packName: 'Terraform', toolId: 'terraform', packVersion: '0.4.0', status: 'ready' as const },
  onOpenFeature: vi.fn(), onOpenDiagnostics: vi.fn(), onOpenTask: vi.fn(),
};
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

test('project selection changes invalidate downstream selections and removal remains disabled', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: true, json: async () => url.includes('/projects') ? { projects: [
      { id: 'project-1', name: 'local', configurationFiles: 1, states: [{ id: 'state-one', name: 'terraform.tfstate' }] },
      { id: 'project-2', name: 'other', configurationFiles: 0, states: [{ id: 'state-two', name: 'other.tfstate' }] },
    ] } : { resources: [{ address: 'aws_instance.demo[0]', type: 'aws_instance', category: 'managed', module: '' }] },
  })));
  render(<TerraformWorkspace {...props} />);
  const project = await screen.findByLabelText('Approved project');
  fireEvent.change(project, { target: { value: 'project-1' } });
  fireEvent.change(screen.getByLabelText('Local state file'), { target: { value: 'state-one' } });
  const selected = await screen.findByLabelText('Selected resource');
  fireEvent.change(selected, { target: { value: 'aws_instance.demo[0]' } });
  expect(screen.getByText('Exact address:')).toBeInTheDocument();
  // Row buttons are distinguishable by address for screen-reader users.
  expect(screen.getByRole('button', { name: 'Selected aws_instance.demo[0]' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.change(project, { target: { value: 'project-2' } });
  expect(screen.queryByText('Exact address:')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Local state file')).toHaveValue('');
  fireEvent.click(screen.getByRole('button', { name: 'State management' }));
  expect(screen.getByRole('button', { name: /Preview removal/ })).toBeDisabled();
});
test('empty authorized project list gives setup guidance without a mutation action', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ projects: [] }) })));
  render(<TerraformWorkspace {...props} />);
  expect(await screen.findByText(/No approved projects/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Preview removal/ })).not.toBeInTheDocument();
});

test('selected project formatting is explicit, filtered, and never shows source', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: true, json: async () => url.includes('/format-check')
      ? { projectId: 'project-1', terraformVersion: '1.16.0', checkedAt: '2026-10-22T13:00:00Z', files: [
        { name: 'good.tf', status: 'formatted' },
        { name: 'bad.tf', status: 'needs-formatting' },
        { name: 'locked.tf', status: 'inspection-failed', reason: 'Inspection failed.' },
      ] }
      : { projects: [{ id: 'project-1', name: 'local', configurationFiles: 3, states: [] }] },
  })));
  render(<TerraformWorkspace {...props} csrfToken="test-token" />);
  fireEvent.click(screen.getByRole('button', { name: 'Configuration' }));
  fireEvent.change(await screen.findByLabelText('Approved project'), { target: { value: 'project-1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Check formatting' }));
  await screen.findByRole('cell', { name: 'Needs formatting' });
  expect(screen.getByText('Inspection failed')).toBeInTheDocument();
  expect(screen.queryByText('SECRET-MUST-NOT-LEAK')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Filter formatting results'), { target: { value: 'failed' } });
  expect(screen.getByText('locked.tf')).toBeInTheDocument();
  expect(screen.queryByText('bad.tf')).not.toBeInTheDocument();
  await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledWith(
    '/api/v1/terraform/format-check?project=project-1',
    expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'X-CLIHarbor-CSRF': 'test-token' }) }),
  ));
});

test('formatting cannot run without an authenticated CSRF token', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({
    projects: [{ id: 'project-1', name: 'local', configurationFiles: 1, states: [] }],
  }) })));
  render(<TerraformWorkspace {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Configuration' }));
  fireEvent.change(await screen.findByLabelText('Approved project'), { target: { value: 'project-1' } });
  expect(screen.getByRole('button', { name: 'Check formatting' })).toBeDisabled();
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
});

test('late formatting response from a previous project cannot contaminate the new selection', async () => {
  let finishOld: ((response: { ok: boolean; json: () => Promise<unknown> }) => void) | undefined;
  vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('/format-check')
    ? new Promise((resolve) => { finishOld = resolve; })
    : Promise.resolve({ ok: true, json: async () => ({ projects: [
      { id: 'project-1', name: 'first', configurationFiles: 1, states: [] },
      { id: 'project-2', name: 'second', configurationFiles: 1, states: [] },
    ] }) }),
  ));
  render(<TerraformWorkspace {...props} csrfToken="test-token" />);
  fireEvent.click(screen.getByRole('button', { name: 'Configuration' }));
  const selector = await screen.findByLabelText('Approved project');
  fireEvent.change(selector, { target: { value: 'project-1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Check formatting' }));
  await waitFor(() => expect(finishOld).toBeDefined());
  fireEvent.change(selector, { target: { value: 'project-2' } });
  finishOld?.({ ok: true, json: async () => ({
    projectId: 'project-1', terraformVersion: '1.16.0', checkedAt: '2026-10-22T13:00:00Z',
    files: [{ name: 'stale.tf', status: 'needs-formatting' }],
  }) });
  await waitFor(() => expect(screen.getByText('No completed formatting check for this project.')).toBeInTheDocument());
  expect(screen.queryByText('stale.tf')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Check formatting' })).toBeEnabled();
});

test('oversized project disables format checks without hiding project selection', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({
    projects: [{ id: 'project-1', name: 'large', configurationFiles: 65, states: [
      { id: 'state-a', name: 'terraform.tfstate' },
    ] }],
  }) })));
  render(<TerraformWorkspace {...props} csrfToken="test-token" />);
  fireEvent.click(screen.getByRole('button', { name: 'Configuration' }));
  fireEvent.change(await screen.findByLabelText('Approved project'), { target: { value: 'project-1' } });
  expect(screen.getByRole('button', { name: 'Check formatting' })).toBeDisabled();
  expect(screen.getByRole('alert')).toHaveTextContent('more than 64');
  expect(screen.getByRole('option', { name: 'terraform.tfstate' })).toBeInTheDocument();
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
});

test('missing Terraform opens the guided setup instead of bypassing it with a direct download', () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ projects: [] }) })));
  render(<TerraformWorkspace {...props} platform={{ ...platform, ready: false }}
    tool={{ ...props.tool, status: 'missing' }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Set up Terraform (no admin required)' }));
  expect(props.onOpenDiagnostics).toHaveBeenCalledExactlyOnceWith();
  expect(screen.queryByRole('link', { name: /Get Terraform/ })).not.toBeInTheDocument();
});

test('incompatible Terraform opens diagnostics without suggesting a missing-install workflow', () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ projects: [] }) })));
  render(<TerraformWorkspace {...props} platform={{ ...platform, ready: false }}
    tool={{ ...props.tool, status: 'incompatible' }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Open Terraform diagnostics' }));
  expect(props.onOpenDiagnostics).toHaveBeenCalledExactlyOnceWith();
  expect(screen.queryByRole('button', { name: /Set up Terraform/ })).not.toBeInTheDocument();
});

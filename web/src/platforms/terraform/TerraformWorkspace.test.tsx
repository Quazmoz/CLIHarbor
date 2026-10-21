import { fireEvent, render, screen } from '@testing-library/react';
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
      { id: 'project-1', name: 'local', states: [{ id: 'state-one', name: 'terraform.tfstate' }] },
      { id: 'project-2', name: 'other', states: [{ id: 'state-two', name: 'other.tfstate' }] },
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

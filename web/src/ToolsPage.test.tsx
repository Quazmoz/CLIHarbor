import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { ToolStatus } from './api/tools';
import { ToolsPage } from './ToolsPage';

afterEach(() => vi.unstubAllGlobals());

function renderTerraform(status: ToolStatus = 'missing', catalog = true, onInstall = vi.fn()) {
  render(<ToolsPage catalog={catalog} tasks={[]} tools={[{
    packId: 'terraform-cli', packName: 'HashiCorp Terraform', packVersion: '0.4.1',
    toolId: 'terraform', status, version: status === 'incompatible' ? '1.4.0' : undefined,
    versionConstraint: '>=1.5.0 <2.0.0',
  }]} installingKey={null} installRoots={{}} notice={null} tasksLocked={false}
    onInstall={onInstall} onRefresh={vi.fn()} onInstallRoot={vi.fn()} onOpenTasks={vi.fn()} onOpenAuthentication={vi.fn()} />);
  return onInstall;
}

test('Terraform offers a no-PATH current-user setup instead of unqualified automatic installation', () => {
  const onInstall = renderTerraform();
  const link = screen.getByRole('link', { name: 'Download Terraform from HashiCorp' });
  expect(link).toHaveAttribute('href', 'https://developer.hashicorp.com/terraform/install');
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  expect(screen.getByText(/no administrator or PATH changes needed/)).toBeInTheDocument();
  expect(screen.getByText(/organization-approved version \(>=1\.5\.0 <2\.0\.0\)/)).toBeInTheDocument();
  expect(screen.getByText('%USERPROFILE%')).toBeInTheDocument();
  expect(screen.getByText('%USERPROFILE%\\bin\\terraform.exe')).toBeInTheDocument();
  expect(screen.getByText(/not in a nested folder/)).toBeInTheDocument();
  expect(screen.getByText(/Refreshing this page alone does not repeat discovery/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Check installation of terraform' })).toBeEnabled();
  expect(screen.getByText(/In-app automatic Terraform installation is disabled/)).toBeInTheDocument();
  expect(onInstall).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: /^Install HashiCorp Terraform/ })).not.toBeInTheDocument();
});

test('Terraform setup can copy the Explorer path without asking the browser to configure executables', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  renderTerraform();
  fireEvent.click(screen.getByRole('button', { name: 'Copy user folder' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('%USERPROFILE%'));
  expect(await screen.findByText(/Copied. Paste into the File Explorer/)).toBeInTheDocument();
});

test('Terraform setup has a manual-copy fallback when clipboard permission is unavailable', async () => {
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn().mockRejectedValue(new Error('blocked')) } });
  renderTerraform();
  fireEvent.click(screen.getByRole('button', { name: 'Copy user folder' }));
  expect(await screen.findByText(/Clipboard unavailable/)).toBeInTheDocument();
  expect(screen.getByText('%USERPROFILE%')).toBeInTheDocument();
});

test('Terraform keeps alternative user-PATH guidance secondary', () => {
  renderTerraform();
  const disclosure = screen.getByText('Already have Terraform elsewhere? Optional PATH setup');
  expect(disclosure.closest('details')).not.toHaveAttribute('open');
  fireEvent.click(disclosure);
  expect(disclosure.closest('details')).toHaveAttribute('open');
  expect(screen.getByText(/Edit environment variables for your account/)).toBeInTheDocument();
  expect(screen.getByText(/User Path/)).toBeInTheDocument();
  expect(screen.getByText(/terraform-cli\/terraform=C:/)).toBeInTheDocument();
});

test('Terraform manual setup is also available in Diagnostics, not only the catalog', () => {
  renderTerraform('missing', false);
  expect(screen.getByRole('heading', { name: 'Tool readiness' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Copy user folder' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Download Terraform from HashiCorp' })).toBeInTheDocument();
});

test('incompatible Terraform warns that user-bin cannot supersede a PATH match', () => {
  renderTerraform('incompatible');
  expect(screen.getByText(/Terraform was found, but its version is not supported/)).toBeInTheDocument();
  expect(screen.getByText(/Detected: 1.4.0/)).toBeInTheDocument();
  expect(screen.getByText(/prefers approved explicit or managed installations, then PATH matches/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Copy user folder' })).not.toBeInTheDocument();
});

test('invalid Terraform overrides require backend correction rather than browser path selection', () => {
  renderTerraform('invalid-override');
  expect(screen.getByText(/configured backend/)).toBeInTheDocument();
  expect(screen.getByText(/The browser cannot change it/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Copy user folder' })).not.toBeInTheDocument();
});

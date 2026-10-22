import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ToolsPage } from './ToolsPage';

afterEach(() => vi.unstubAllGlobals());

function renderMissingTerraform(onInstall = vi.fn()) {
  render(<ToolsPage catalog tasks={[]} tools={[{
    packId: 'terraform-cli', packName: 'HashiCorp Terraform', packVersion: '0.4.1',
    toolId: 'terraform', status: 'missing', versionConstraint: '>=1.5.0 <2.0.0',
  }]} installingKey={null} installRoots={{}} notice={null} tasksLocked={false}
    onInstall={onInstall} onInstallRoot={vi.fn()} onOpenTasks={vi.fn()} onOpenAuthentication={vi.fn()} />);
  return onInstall;
}

test('Terraform offers a no-PATH current-user setup instead of unqualified automatic installation', () => {
  const onInstall = renderMissingTerraform();
  const link = screen.getByRole('link', { name: 'Download Terraform from HashiCorp' });
  expect(link).toHaveAttribute('href', 'https://developer.hashicorp.com/terraform/install');
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  expect(screen.getByText(/no administrator or PATH changes needed/)).toBeInTheDocument();
  expect(screen.getByText(/>=1.5.0 <2.0.0/)).toBeInTheDocument();
  expect(screen.getByText('%USERPROFILE%\\bin')).toBeInTheDocument();
  expect(screen.getByText(/directly inside that/)).toBeInTheDocument();
  expect(screen.getByText(/Refreshing this page alone is not enough/)).toBeInTheDocument();
  expect(screen.getByText(/In-app automatic Terraform installation is disabled/)).toBeInTheDocument();
  expect(onInstall).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: /^Install HashiCorp Terraform/ })).not.toBeInTheDocument();
});

test('Terraform setup can copy the Explorer path without asking the browser to configure executables', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  renderMissingTerraform();
  fireEvent.click(screen.getByRole('button', { name: 'Copy folder path' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('%USERPROFILE%\\bin'));
  expect(await screen.findByText(/Copied. Paste into the File Explorer/)).toBeInTheDocument();
});

test('Terraform setup has a manual-copy fallback when clipboard permission is unavailable', async () => {
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn().mockRejectedValue(new Error('blocked')) } });
  renderMissingTerraform();
  fireEvent.click(screen.getByRole('button', { name: 'Copy folder path' }));
  expect(await screen.findByText(/Clipboard unavailable/)).toBeInTheDocument();
  expect(screen.getByText('%USERPROFILE%\\bin')).toBeInTheDocument();
});

test('Terraform keeps alternative user-PATH guidance secondary', () => {
  renderMissingTerraform();
  const disclosure = screen.getByText('Already have Terraform elsewhere? Optional PATH setup');
  expect(disclosure.closest('details')).not.toHaveAttribute('open');
  fireEvent.click(disclosure);
  expect(disclosure.closest('details')).toHaveAttribute('open');
  expect(screen.getByText(/Edit environment variables for your account/)).toBeInTheDocument();
  expect(screen.getByText(/User Path/)).toBeInTheDocument();
  expect(screen.getByText(/terraform-cli\/terraform=C:/)).toBeInTheDocument();
});

import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { ToolsPage } from './ToolsPage';

test('Terraform displays official user-install path without pretending to run an unverified managed install', () => {
  const onInstall = vi.fn();
  render(<ToolsPage catalog tasks={[]} tools={[{
    packId: 'terraform-cli', packName: 'HashiCorp Terraform', packVersion: '0.4.1',
    toolId: 'terraform', status: 'missing',
  }]} installingKey={null} installRoots={{}} notice={null} tasksLocked={false}
    onInstall={onInstall} onInstallRoot={vi.fn()} onOpenTasks={vi.fn()} onOpenAuthentication={vi.fn()} />);
  const link = screen.getByRole('link', { name: 'Get Terraform — official download' });
  expect(link).toHaveAttribute('href', 'https://developer.hashicorp.com/terraform/install');
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  expect(screen.getByText(/no administrator rights required/)).toBeInTheDocument();
  expect(screen.getByText(/In-app one-click installation is not yet enabled/)).toBeInTheDocument();
  expect(onInstall).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: /^Install HashiCorp Terraform/ })).not.toBeInTheDocument();
});

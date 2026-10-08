import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { PackAuthoringWizard } from './PackAuthoringWizard';

describe('custom CLI pack wizard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test('opens a preview-only path and never offers automatic activation', () => {
    render(<PackAuthoringWizard registeredPackIds={['conjur']} />);
    expect(screen.queryByLabelText('Pack ID')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start authoring' }));
    expect(screen.getByRole('button', { name: 'Download pack draft (.yaml)' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Pack ID'), { target: { value: 'acme-cli' } });
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Acme CLI' } });
    fireEvent.change(screen.getByLabelText('Tool ID'), { target: { value: 'acme' } });
    fireEvent.change(screen.getByLabelText('Executable filename (basename only)'), { target: { value: 'acme' } });
    expect(screen.getByRole('button', { name: 'Download pack draft (.yaml)' })).toBeEnabled();
    expect(screen.getByLabelText('Generated YAML — no runnable tasks')).toHaveValue(expect.stringContaining('commands: {}'));
    expect(screen.getByText(/has not been validated, trusted, or loaded/i)).not.toBeInTheDocument();
    expect(screen.getByText(/explicitly load the reviewed pack/i)).toBeInTheDocument();
  });

  test('blocks an existing pack and disallowed executable names', () => {
    render(<PackAuthoringWizard registeredPackIds={['acme-cli']} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start authoring' }));
    fireEvent.change(screen.getByLabelText('Pack ID'), { target: { value: 'acme-cli' } });
    expect(screen.getByText(/already loaded/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Executable filename (basename only)'), { target: { value: 'powershell.exe' } });
    expect(screen.getByText(/not a path, script, shell/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download pack draft (.yaml)' })).toBeDisabled();
  });
});

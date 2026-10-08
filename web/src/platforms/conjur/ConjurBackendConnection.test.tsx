import { afterEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConjurBackendConnection, normalizeConjurSaaSAPIURL } from './ConjurBackendConnection';
import type { RuntimeStatus } from '../../api/status';
import type { ToolDiagnostic } from '../../api/tools';

const status: RuntimeStatus = {
  name: 'CLIHarbor', version: 'dev', session: 'active', csrfToken: 'csrf-connection',
};
const tool: ToolDiagnostic = {
  packId: 'cyberark-conjur-v9', packName: 'Conjur', packVersion: '0.1.2',
  toolId: 'conjur', status: 'ready', credentialLogin: { method: 'conjur-vendor-login' },
};
const old = 'https://old.secretsmgr.cyberark.cloud/api';
const next = 'https://new.secretsmgr.cyberark.cloud/api';

function response(body: unknown, statusCode = 200): Response {
  return new Response(JSON.stringify(body), {
    status: statusCode, headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('Conjur API backend connection', () => {
  test('accepts only direct CyberArk Secrets Manager SaaS API tenant URLs', () => {
    expect(normalizeConjurSaaSAPIURL('https://companyname.secretsmgr.cyberark.cloud'))
      .toBe('https://companyname.secretsmgr.cyberark.cloud/api');
    expect(normalizeConjurSaaSAPIURL('https://companyname.secretsmgr.cyberark.cloud/api'))
      .toBe('https://companyname.secretsmgr.cyberark.cloud/api');
    for (const input of [
      'https://companyname.cyberark.cloud',
      'http://companyname.secretsmgr.cyberark.cloud',
      'https://evil.test',
      'https://companyname.secretsmgr.cyberark.cloud.evil.test',
      'https://user:pass@companyname.secretsmgr.cyberark.cloud',
      'https://companyname.secretsmgr.cyberark.cloud/login',
      'https://companyname.secretsmgr.cyberark.cloud:8443',
      'https://companyname.secretsmgr.cyberark.cloud/?token=1',
      'https://companyname.secretsmgr.cyberark.cloud#fragment',
      'https://companyname.secretsmgr.cyberark.cloud\n',
    ]) {
      expect(normalizeConjurSaaSAPIURL(input)).toBeNull();
    }
  });

  test('shows effective CLI endpoint and requires explicit replacement acknowledgement', async () => {
    let reads = 0;
    let written: Record<string, unknown> | undefined;
    const invalidate = vi.fn();
    const refresh = vi.fn();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof input === 'string' ? input : String(input);
      expect(path).toBe('/api/v1/auth/configure');
      if (init?.method === 'POST') {
        written = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(init.headers).toMatchObject({ 'X-CLIHarbor-CSRF': status.csrfToken });
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      reads += 1;
      return Promise.resolve(response({
        environment: 'saas', applianceUrl: reads === 1 ? old : next,
        account: 'conjur', configurable: true,
      }));
    }));
    render(<ConjurBackendConnection status={status} tool={tool} ready
      invalidateSession={invalidate} onToolsChanged={refresh} />);
    expect(await screen.findByText(old)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change API endpoint' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Change API endpoint' }));
    const field = screen.getByRole('textbox', { name: 'Secrets Manager API URL' });
    fireEvent.change(field, { target: { value: next } });
    const submit = screen.getByRole('button', { name: 'Replace CLI API endpoint' });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /replace the existing vendor CLI connection/i }));
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(written).toEqual({
      packId: tool.packId, toolId: tool.toolId, environment: 'saas',
      applianceUrl: next, account: 'conjur', authnType: 'cloud',
      expectedApplianceUrl: old,
    });
    expect(screen.getByText(/endpoint saved and verified/i)).toBeInTheDocument();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(JSON.stringify(written)).not.toContain('credential');
  });

  test('first setup creates SaaS connection without overwrite flag or identity credentials', async () => {
    let reads = 0;
    let written: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        written = JSON.parse(String(init.body)) as Record<string, unknown>;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      reads++;
      return Promise.resolve(response(reads === 1
        ? { environment: 'unconfigured', applianceUrl: '', account: '', configurable: true }
        : { environment: 'saas', applianceUrl: next, account: 'conjur', configurable: true }));
    }));
    render(<ConjurBackendConnection status={status} tool={tool} ready />);
    const field = await screen.findByRole('textbox', { name: 'Secrets Manager API URL' });
    fireEvent.change(field, { target: { value: 'https://new.secretsmgr.cyberark.cloud' } });
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Configure CLI API endpoint' }));
    expect(await screen.findByText(/endpoint saved and verified/i)).toBeInTheDocument();
    expect(written?.expectedApplianceUrl).toBeUndefined();
  });

  test('never keeps old session evidence after an ambiguous vendor configuration failure', async () => {
    const invalidate = vi.fn();
    const refresh = vi.fn();
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve(response({
          error: {
            code: 'authentication_unavailable', category: 'lifecycle',
            message: 'Vendor authentication is not currently available.',
            remediation: 'Inspect vendor configuration before retrying.',
            retryable: true,
          },
        }, 503));
      }
      return Promise.resolve(response({
        environment: 'saas', applianceUrl: old, account: 'conjur', configurable: true,
      }));
    }));
    render(<ConjurBackendConnection status={status} tool={tool} ready
      invalidateSession={invalidate} onToolsChanged={refresh} />);
    expect(await screen.findByText(old)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Change API endpoint' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Secrets Manager API URL' }), {
      target: { value: next },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /replace the existing vendor CLI connection/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Replace CLI API endpoint' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Vendor authentication is not currently available.');
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.queryByText(/endpoint saved and verified/i)).not.toBeInTheDocument();
  });

  test('does not claim success if post-init vendor readback disagrees', async () => {
    const invalidate = vi.fn();
    let reads = 0;
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.resolve(new Response(null, { status: 204 }));
      reads += 1;
      return Promise.resolve(response({
        environment: 'saas', applianceUrl: old, account: 'conjur', configurable: true,
      }));
    }));
    render(<ConjurBackendConnection status={status} tool={tool} ready invalidateSession={invalidate} />);
    expect(await screen.findByText(old)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Change API endpoint' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Secrets Manager API URL' }), {
      target: { value: next },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /replace the existing vendor CLI connection/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Replace CLI API endpoint' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The CLI did not report the requested endpoint');
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(reads).toBe(2);
    expect(screen.queryByText(/endpoint saved and verified/i)).not.toBeInTheDocument();
  });

  test('does not offer reconfiguration for an unsupported externally managed mode', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(response({
      environment: 'other', applianceUrl: 'https://custom.example.test',
      account: 'custom', configurable: false,
    }))));
    render(<ConjurBackendConnection status={status} tool={tool} ready />);
    expect(await screen.findByText('https://custom.example.test')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change API endpoint' })).not.toBeInTheDocument();
    expect(screen.getByText(/must be managed through the official CLI/i)).toBeInTheDocument();
  });
});

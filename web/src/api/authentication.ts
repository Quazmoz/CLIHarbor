import { clientError, errorFromResponse } from './errors';

export interface CredentialConfigurationRequest {
  packId: string;
  toolId: string;
  applianceUrl: string;
  account: string;
  authnType: 'authn' | 'ldap' | 'cloud';
  serviceId?: string;
  environment?: 'saas';
  expectedApplianceUrl?: string;
}

export interface VendorConnection {
  environment: 'saas' | 'self-hosted' | 'unconfigured' | 'other';
  applianceUrl: string;
  account: string;
  configurable: boolean;
}

export async function getVendorConnection(signal?: AbortSignal): Promise<VendorConnection> {
  const response = await fetch('/api/v1/auth/configure', {
    method: 'GET',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) throw await errorFromResponse(response);
  const data: unknown = await response.json();
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw clientError('invalid_response');
  const value = data as Record<string, unknown>;
  if (!['saas', 'self-hosted', 'unconfigured', 'other'].includes(String(value.environment)) ||
      typeof value.applianceUrl !== 'string' || value.applianceUrl.length > 2048 ||
      typeof value.account !== 'string' || value.account.length > 256 ||
      typeof value.configurable !== 'boolean' ||
      /[\u0000-\u001f\u007f]/.test(value.applianceUrl) ||
      /[\u0000-\u001f\u007f]/.test(value.account)) {
    throw clientError('invalid_response');
  }
  return value as unknown as VendorConnection;
}

export interface CredentialLoginRequest {
  packId: string;
  toolId: string;
  identity: string;
  secret: string;
}

export interface CredentialInteractiveLoginRequest {
  packId: string;
  toolId: string;
}

async function expectNoContent(response: Response): Promise<void> {
  if (!response.ok) {
    throw await errorFromResponse(response);
  }
  if (response.status !== 204) {
    throw clientError('invalid_response');
  }
}

export async function configureCredentialConnection(
  csrfToken: string,
  request: CredentialConfigurationRequest,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch('/api/v1/auth/configure', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-CLIHarbor-CSRF': csrfToken,
    },
    body: JSON.stringify(request),
    signal,
  });

  await expectNoContent(response);
}

export async function loginWithCredentials(
  csrfToken: string,
  request: CredentialLoginRequest,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch('/api/v1/auth/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-CLIHarbor-CSRF': csrfToken,
    },
    body: JSON.stringify(request),
    signal,
  });

  await expectNoContent(response);
}


export async function launchInteractiveLogin(
  csrfToken: string,
  request: CredentialInteractiveLoginRequest,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch('/api/v1/auth/interactive', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-CLIHarbor-CSRF': csrfToken,
    },
    body: JSON.stringify(request),
    signal,
  });

  await expectNoContent(response);
}

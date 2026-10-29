import { clientError, errorFromResponse } from './errors';
import { fetchWithDeadline, READ_TIMEOUTS } from './http';

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

// Match the vendor response contract: reject ASCII C0 controls and DEL without
// disabling ESLint's control-character regex protection.
function containsAsciiControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export async function getVendorConnection(signal?: AbortSignal): Promise<VendorConnection> {
  const response = await fetchWithDeadline('/api/v1/auth/configure', {
    method: 'GET',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    signal,
  }, READ_TIMEOUTS.fast);
  if (!response.ok) throw await errorFromResponse(response);
  const data: unknown = await response.json();
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw clientError('invalid_response');
  const value = data as Record<string, unknown>;
  if (!['saas', 'self-hosted', 'unconfigured', 'other'].includes(String(value.environment)) ||
      typeof value.applianceUrl !== 'string' || value.applianceUrl.length > 2048 ||
      typeof value.account !== 'string' || value.account.length > 256 ||
      typeof value.configurable !== 'boolean' ||
      containsAsciiControl(value.applianceUrl) ||
      containsAsciiControl(value.account)) {
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

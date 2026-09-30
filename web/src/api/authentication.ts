import { clientError, errorFromResponse } from './errors';

export interface CredentialConfigurationRequest {
  packId: string;
  toolId: string;
  applianceUrl: string;
  account: string;
  authnType: 'authn' | 'ldap';
  serviceId?: string;
}

export interface CredentialLoginRequest {
  packId: string;
  toolId: string;
  identity: string;
  secret: string;
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

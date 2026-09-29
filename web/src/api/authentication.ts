import { clientError, errorFromResponse } from './errors';

export interface CredentialLoginRequest {
  packId: string;
  toolId: string;
  identity: string;
  secret: string;
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

  if (!response.ok) {
    throw await errorFromResponse(response);
  }
  if (response.status !== 204) {
    throw clientError('invalid_response');
  }
}

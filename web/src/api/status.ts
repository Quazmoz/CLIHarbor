import { clientError, errorFromResponse } from './errors';

export interface RuntimeStatus {
  name: string;
  version: string;
  session: 'active';
  csrfToken: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseRuntimeStatus(value: unknown): RuntimeStatus {
  if (!isRecord(value)) {
    throw clientError('invalid_response');
  }

  const { name, version, session, csrfToken } = value;
  if (typeof name !== 'string' || name.length === 0 || typeof version !== 'string' || version.length === 0) {
    throw clientError('invalid_response');
  }
  if (session !== 'active') {
    throw clientError('invalid_response');
  }
  if (typeof csrfToken !== 'string' || csrfToken.length === 0) {
    throw clientError('invalid_response');
  }

  return { name, version, session, csrfToken };
}

export async function fetchRuntimeStatus(signal?: AbortSignal): Promise<RuntimeStatus> {
  const response = await fetch('/api/v1/status', {
    method: 'GET',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    signal,
  });

  if (!response.ok) {
    throw await errorFromResponse(response);
  }

  return parseRuntimeStatus(await response.json());
}

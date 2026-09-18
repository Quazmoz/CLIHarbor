export interface RuntimeStatus {
  name: string;
  version: string;
  session: 'active';
}

export class SessionUnavailableError extends Error {
  constructor() {
    super('The local browser session is not active. Relaunch CLIHarbor to establish a new secure session.');
    this.name = 'SessionUnavailableError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseRuntimeStatus(value: unknown): RuntimeStatus {
  if (!isRecord(value)) {
    throw new Error('CLIHarbor returned an invalid status response.');
  }

  const { name, version, session } = value;
  if (typeof name !== 'string' || name.length === 0 || typeof version !== 'string' || version.length === 0) {
    throw new Error('CLIHarbor returned an invalid status response.');
  }
  if (session !== 'active') {
    throw new Error('CLIHarbor returned an unknown browser-session state.');
  }

  return { name, version, session };
}

export async function fetchRuntimeStatus(signal?: AbortSignal): Promise<RuntimeStatus> {
  const response = await fetch('/api/v1/status', {
    method: 'GET',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    signal,
  });

  if (response.status === 401) {
    throw new SessionUnavailableError();
  }
  if (!response.ok) {
    throw new Error(`CLIHarbor status request failed with HTTP ${response.status}.`);
  }

  return parseRuntimeStatus(await response.json());
}

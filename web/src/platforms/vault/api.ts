import { fetchWithDeadline, READ_TIMEOUTS } from '../../api/http';
import { clientError, errorFromResponse } from '../../api/errors';

export interface VaultContext { address?: string; namespace?: string; ready: boolean }
export interface VaultLocation { mount: string; path: string }
export interface VaultList extends VaultLocation { keys: string[]; failureCode?: string }
export interface VaultField { key: string; value: string }
export interface VaultReveal extends VaultLocation { version: number; fields: VaultField[]; failureCode?: string }
export interface VaultAccessEntry { at: string; address: string; mount: string; path: string; outcome: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
// Vault names and codes are untrusted display text.
const safeText = (value: unknown, max = 1024): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value);
const optionalCode = (value: unknown) => {
  if (value === undefined) return undefined;
  if (!safeText(value, 64)) throw clientError('invalid_response');
  return value;
};

async function post(path: string, csrfToken: string, body: VaultLocation): Promise<Record<string, unknown>> {
  const response = await fetch('/api/v1/vault/kv/' + path, {
    method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CLIHarbor-CSRF': csrfToken },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await errorFromResponse(response);
  const payload: unknown = await response.json();
  // A response is only ever shown for the exact location that was requested.
  if (!isRecord(payload) || payload.mount !== body.mount || payload.path !== body.path) throw clientError('invalid_response');
  return payload;
}

export async function fetchVaultContext(signal?: AbortSignal): Promise<VaultContext> {
  const response = await fetchWithDeadline('/api/v1/vault/context', { credentials: 'same-origin', headers: { Accept: 'application/json' }, signal }, READ_TIMEOUTS.fast);
  if (!response.ok) throw await errorFromResponse(response);
  const payload: unknown = await response.json();
  if (!isRecord(payload) || typeof payload.ready !== 'boolean' ||
    (payload.address !== undefined && payload.address !== '' && !safeText(payload.address, 512)) ||
    (payload.namespace !== undefined && !safeText(payload.namespace, 256))) throw clientError('invalid_response');
  return { ready: payload.ready, address: (payload.address as string) || undefined, namespace: payload.namespace as string | undefined };
}

export async function listVaultKeys(csrfToken: string, location: VaultLocation): Promise<VaultList> {
  const payload = await post('list', csrfToken, location);
  if (!Array.isArray(payload.keys) || payload.keys.length > 1000 || !payload.keys.every((key) => safeText(key, 512))) throw clientError('invalid_response');
  return { ...location, keys: payload.keys as string[], failureCode: optionalCode(payload.failureCode) };
}

export async function revealVaultSecret(csrfToken: string, location: VaultLocation): Promise<VaultReveal> {
  const payload = await post('reveal', csrfToken, location);
  const failureCode = optionalCode(payload.failureCode);
  const version = payload.version ?? 0;
  const rawFields = payload.fields ?? [];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0 ||
    !Array.isArray(rawFields) || (failureCode !== undefined && rawFields.length > 0)) throw clientError('invalid_response');
  const fields = rawFields.map((item: unknown) => {
    if (!isRecord(item) || !safeText(item.key, 512) || typeof item.value !== 'string') throw clientError('invalid_response');
    return { key: item.key, value: item.value };
  });
  return { ...location, version, fields, failureCode };
}

export async function fetchVaultAccessLog(signal?: AbortSignal): Promise<VaultAccessEntry[]> {
  const response = await fetch('/api/v1/vault/kv/access-log', { credentials: 'same-origin', headers: { Accept: 'application/json' }, signal });
  if (!response.ok) throw await errorFromResponse(response);
  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload.entries)) throw clientError('invalid_response');
  return payload.entries.map((item: unknown) => {
    if (!isRecord(item) || !safeText(item.at, 64) || !safeText(item.address, 512) || !safeText(item.mount, 256) ||
      !safeText(item.path) || !safeText(item.outcome, 64)) throw clientError('invalid_response');
    return { at: item.at, address: item.address, mount: item.mount, path: item.path, outcome: item.outcome };
  });
}

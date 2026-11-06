import { clientError, errorFromResponse } from '../../api/errors';

export interface SecretTarget { packId: string; toolId: string; account: string; applianceUrl: string }
export interface SecretVersion { version: number; expiresAt?: string }
export interface SecretVersions { variableId: string; versions: SecretVersion[]; failureCode?: string }
export interface SecretReveal { variableId: string; version: number; value?: string; failureCode?: string }
export interface SecretAccessEntry { at: string; account: string; applianceUrl: string; variableId: string; version: number; outcome: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
// Identifiers and codes are untrusted display text: bound them and refuse
// control, format and bidi-override characters before React renders them.
const safeText = (value: unknown, max = 2048): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value);
const optionalCode = (value: unknown) => {
  if (value === undefined) return undefined;
  if (!safeText(value, 64)) throw clientError('invalid_response');
  return value;
};
const version = (value: unknown) => {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw clientError('invalid_response');
  return value;
};

async function post(path: string, csrfToken: string, body: unknown): Promise<unknown> {
  const response = await fetch('/api/v1/conjur/secrets/' + path, {
    method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CLIHarbor-CSRF': csrfToken },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await errorFromResponse(response);
  return response.json();
}

export async function listSecretVersions(csrfToken: string, target: SecretTarget, variableId: string): Promise<SecretVersions> {
  const payload = await post('versions', csrfToken, { ...target, variableId });
  if (!isRecord(payload) || payload.variableId !== variableId || !Array.isArray(payload.versions)) throw clientError('invalid_response');
  return {
    variableId,
    versions: payload.versions.map((item) => {
      if (!isRecord(item) || (item.expiresAt !== undefined && !safeText(item.expiresAt, 64))) throw clientError('invalid_response');
      const number = version(item.version);
      if (number === 0) throw clientError('invalid_response');
      return { version: number, expiresAt: item.expiresAt as string | undefined };
    }),
    failureCode: optionalCode(payload.failureCode),
  };
}

export async function revealSecret(csrfToken: string, target: SecretTarget, variableId: string, selected: number): Promise<SecretReveal> {
  const payload = await post('reveal', csrfToken, { ...target, variableId, version: selected });
  if (!isRecord(payload) || payload.variableId !== variableId || version(payload.version) !== selected ||
    (payload.value !== undefined && typeof payload.value !== 'string')) throw clientError('invalid_response');
  const failureCode = optionalCode(payload.failureCode);
  if ((failureCode === undefined) === (payload.value === undefined)) throw clientError('invalid_response');
  return { variableId, version: selected, value: payload.value as string | undefined, failureCode };
}

export async function fetchSecretAccessLog(signal?: AbortSignal): Promise<SecretAccessEntry[]> {
  const response = await fetch('/api/v1/conjur/secrets/access-log', { credentials: 'same-origin', headers: { Accept: 'application/json' }, signal });
  if (!response.ok) throw await errorFromResponse(response);
  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload.entries)) throw clientError('invalid_response');
  return payload.entries.map((item) => {
    if (!isRecord(item) || !safeText(item.at, 64) || !safeText(item.account, 256) || !safeText(item.applianceUrl) ||
      !safeText(item.variableId) || !safeText(item.outcome, 64)) throw clientError('invalid_response');
    return { at: item.at, account: item.account, applianceUrl: item.applianceUrl, variableId: item.variableId, version: version(item.version), outcome: item.outcome };
  });
}

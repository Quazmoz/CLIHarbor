import { clientError, errorFromResponse } from './errors';

export type SecretAuditState = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';
export type SecretAuditConfidence = 'high' | 'medium';
export type SecretAuditScanType = 'references' | 'contains' | 'exact' | 'regex';

export interface SecretAuditFinding {
  variableId: string;
  confidence: SecretAuditConfidence;
  reason: string;
}

export interface SecretAuditFailure {
  variableId: string;
  code: string;
}

export interface SecretAuditSnapshot {
  available: boolean;
  packId?: string;
  toolId?: string;
  target?: { applianceUrl: string; account: string };
  state: SecretAuditState;
  phase?: string;
  minimumConfidence?: SecretAuditConfidence;
  scanType?: SecretAuditScanType;
  startedAt?: string;
  finishedAt?: string;
  total: number;
  processed: number;
  inspected: number;
  failureCode?: string;
  findings: SecretAuditFinding[];
  failures: SecretAuditFailure[];
}

const endpoint = '/api/v1/conjur/secret-audit';
const states: SecretAuditState[] = ['idle', 'running', 'completed', 'failed', 'cancelled'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Server values are untrusted display text: bound length and refuse control,
// format, and bidi-override characters before React renders them.
function safeText(value: unknown, max = 2048): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value);
}

function optionalText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!safeText(value, 256)) throw clientError('invalid_response');
  return value;
}

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw clientError('invalid_response');
  return value;
}

function confidence(value: unknown): SecretAuditConfidence {
  if (value !== 'high' && value !== 'medium') throw clientError('invalid_response');
  return value;
}

export function parseSecretAuditSnapshot(payload: unknown): SecretAuditSnapshot {
  if (
    !isRecord(payload) ||
    typeof payload.available !== 'boolean' ||
    !states.includes(payload.state as SecretAuditState) ||
    !(payload.findings === null || Array.isArray(payload.findings)) ||
    !(payload.failures === null || Array.isArray(payload.failures))
  ) {
    throw clientError('invalid_response');
  }
  let target: SecretAuditSnapshot['target'];
  if (payload.target !== undefined) {
    if (!isRecord(payload.target) || !safeText(payload.target.applianceUrl, 2048) || !(payload.target.account === '' || safeText(payload.target.account, 256))) {
      throw clientError('invalid_response');
    }
    target = { applianceUrl: payload.target.applianceUrl, account: payload.target.account as string };
  }
  const findings = ((payload.findings ?? []) as unknown[]).map((item) => {
    if (!isRecord(item) || !safeText(item.variableId) || !safeText(item.reason, 64)) throw clientError('invalid_response');
    return { variableId: item.variableId, confidence: confidence(item.confidence), reason: item.reason };
  });
  const failures = ((payload.failures ?? []) as unknown[]).map((item) => {
    if (!isRecord(item) || !safeText(item.variableId) || !safeText(item.code, 64)) throw clientError('invalid_response');
    return { variableId: item.variableId, code: item.code };
  });
  if (payload.scanType !== undefined && !['references', 'contains', 'exact', 'regex'].includes(payload.scanType as string)) {
    throw clientError('invalid_response');
  }
  return {
    available: payload.available,
    packId: optionalText(payload.packId),
    toolId: optionalText(payload.toolId),
    target,
    state: payload.state as SecretAuditState,
    phase: optionalText(payload.phase),
    minimumConfidence: payload.minimumConfidence === undefined ? undefined : confidence(payload.minimumConfidence),
    scanType: payload.scanType as SecretAuditScanType | undefined,
    startedAt: optionalText(payload.startedAt),
    finishedAt: optionalText(payload.finishedAt),
    total: count(payload.total),
    processed: count(payload.processed),
    inspected: count(payload.inspected),
    failureCode: optionalText(payload.failureCode),
    findings,
    failures,
  };
}

async function send(method: string, csrfToken?: string, body?: unknown, signal?: AbortSignal): Promise<SecretAuditSnapshot> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (csrfToken !== undefined) headers['X-CLIHarbor-CSRF'] = csrfToken;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(endpoint, {
    method,
    credentials: 'same-origin',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    throw await errorFromResponse(response);
  }
  return parseSecretAuditSnapshot(await response.json());
}

export function fetchSecretAudit(signal?: AbortSignal): Promise<SecretAuditSnapshot> {
  return send('GET', undefined, undefined, signal);
}

export function startSecretAudit(
  csrfToken: string,
  request: {
    packId: string;
    toolId: string;
    minimumConfidence: SecretAuditConfidence;
    applianceUrl: string;
    scanType: SecretAuditScanType;
    pattern?: string;
  },
): Promise<SecretAuditSnapshot> {
  return send('POST', csrfToken, request);
}

export function cancelSecretAudit(csrfToken: string): Promise<SecretAuditSnapshot> {
  return send('DELETE', csrfToken);
}

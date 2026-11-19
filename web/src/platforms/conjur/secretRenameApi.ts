import { clientError, errorFromResponse } from '../../api/errors';
import type { SecretTarget } from './secretRetrievalApi';

export interface RenameRequest {
  target: SecretTarget & { variableId: string };
  destination: string;
  approvalId?: string;
  confirmation?: string;
}
export interface RenameResult {
  source: string;
  destination: string;
  status: 'reviewed' | 'copied' | 'deleted' | 'discarded' | 'stopped';
  approvalId?: string;
  expiresAt?: string;
  owner?: string;
  policy?: string;
  grants: number;
  annotations: number;
  versions: { source: number; destination: number }[];
  runIds: string[];
  failureCode?: string;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value);
const integer = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;

export async function renameSecret(action: 'review' | 'copy' | 'delete' | 'discard', csrfToken: string, request: RenameRequest, signal?: AbortSignal): Promise<RenameResult> {
  const response = await fetch('/api/v1/conjur/secrets/rename/' + action, {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CLIHarbor-CSRF': csrfToken },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw await errorFromResponse(response);
  const value: unknown = await response.json();
  if (!record(value) || value.source !== request.target.variableId || value.destination !== request.destination ||
    !['reviewed', 'copied', 'deleted', 'discarded', 'stopped'].includes(String(value.status)) ||
    !integer(value.grants, 100) || !integer(value.annotations, 100) ||
    !Array.isArray(value.versions) || value.versions.length > 100 ||
    !Array.isArray(value.runIds) || value.runIds.length > 302 || !value.runIds.every(text) ||
    [value.owner, value.policy, value.failureCode].some((item) => item !== undefined && !text(item)) ||
    (value.approvalId !== undefined && (typeof value.approvalId !== 'string' || !/^[a-f0-9]{64}$/u.test(value.approvalId))) ||
    (value.expiresAt !== undefined && (!text(value.expiresAt) || !Number.isFinite(Date.parse(value.expiresAt))))) {
    throw clientError('invalid_response');
  }
  const versions = value.versions.map((item) => {
    if (!record(item) || !integer(item.source, 1 << 20) || item.source === 0 || !integer(item.destination, 1 << 20)) {
      throw clientError('invalid_response');
    }
    return { source: item.source, destination: item.destination };
  });
  const status = value.status as RenameResult['status'];
  const expected = { review: 'reviewed', copy: 'copied', delete: 'deleted', discard: 'discarded' }[action];
  if ((status === 'stopped') !== (value.failureCode !== undefined) ||
    (status !== 'stopped' && status !== expected) ||
    ((status === 'reviewed' || status === 'copied') && (!value.approvalId || !value.expiresAt || !value.owner || !value.policy || versions.length === 0)) ||
    ((status === 'copied' || status === 'deleted') && (versions.some((item) => item.destination === 0) ||
      new Set(versions.map((item) => item.destination)).size !== versions.length)) ||
    new Set(versions.map((item) => item.source)).size !== versions.length) {
    throw clientError('invalid_response');
  }
  return {
    source: request.target.variableId, destination: request.destination, status, versions,
    grants: value.grants, annotations: value.annotations, runIds: value.runIds,
    approvalId: value.approvalId as string | undefined, expiresAt: value.expiresAt as string | undefined,
    owner: value.owner as string | undefined, policy: value.policy as string | undefined, failureCode: value.failureCode as string | undefined,
  };
}

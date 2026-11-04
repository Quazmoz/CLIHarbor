import { clientError, errorFromResponse } from './errors';
import { fetchWithDeadline, READ_TIMEOUTS } from './http';

export interface SharingStatus {
  state: 'idle' | 'waiting' | 'received' | 'revealed' | 'expired' | 'cancelled' | 'unavailable' | 'closed';
  addresses: string[];
  browserAvailable: boolean;
  id?: string;
  mode?: 'app' | 'browser';
  origin?: string;
  fingerprint?: string;
  expiresAt?: string;
}
export interface Destination { origin: string; fingerprint: string }
const endpoint = '/api/v1/password-sharing';
const states = new Set(['idle', 'waiting', 'received', 'revealed', 'expired', 'cancelled', 'unavailable', 'closed']);
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const fingerprint = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
function origin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 80) return false;
  try { const u = new URL(value); return u.protocol === 'https:' && /^\d+\.\d+\.\d+\.\d+$/u.test(u.hostname) && u.port !== '' && u.origin === value; }
  catch { return false; }
}
function status(value: unknown): SharingStatus {
  if (!record(value) || Object.keys(value).some((key) => !['state', 'addresses', 'browserAvailable', 'id', 'mode', 'origin', 'fingerprint', 'expiresAt'].includes(key)) ||
      typeof value.state !== 'string' || !states.has(value.state) || !Array.isArray(value.addresses) || value.addresses.length > 100 ||
      value.addresses.some((address) => typeof address !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/u.test(address)) ||
      typeof value.browserAvailable !== 'boolean' ||
      value.id !== undefined && (typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{22}$/u.test(value.id)) ||
      value.mode !== undefined && value.mode !== 'app' && value.mode !== 'browser' ||
      value.origin !== undefined && !origin(value.origin) ||
      value.fingerprint !== undefined && !fingerprint(value.fingerprint) ||
      value.expiresAt !== undefined && (typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt)))) throw clientError('invalid_response');
  if (['waiting', 'received'].includes(String(value.state)) && (!value.id || !value.origin || !value.fingerprint || !value.expiresAt || !value.mode)) throw clientError('invalid_response');
  return value as unknown as SharingStatus;
}
async function post(csrf: string, path: string, body: unknown): Promise<Response> {
  const response = await fetch(endpoint + path, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-CLIHarbor-CSRF': csrf }, body: JSON.stringify(body) });
  if (!response.ok) throw await errorFromResponse(response);
  return response;
}
export async function fetchSharingStatus(signal?: AbortSignal): Promise<SharingStatus> {
  const response = await fetchWithDeadline(endpoint, { credentials: 'same-origin', cache: 'no-store', signal }, READ_TIMEOUTS.fast);
  if (!response.ok) throw await errorFromResponse(response);
  return status(await response.json());
}
export async function createInvitation(csrf: string, address: string, mode: 'app' | 'browser') {
  const response = await post(csrf, '/create', { address, mode });
  const data: unknown = await response.json();
  if (!record(data) || typeof data.invitation !== 'string' || data.invitation.length > 1024) throw clientError('invalid_response');
  const parsed = status(data.status);
  if (!data.invitation.startsWith(parsed.origin + '/#') || parsed.state !== 'waiting') throw clientError('invalid_response');
  return { status: parsed, invitation: data.invitation };
}
export async function cancelInvitation(csrf: string, id: string) { if ((await post(csrf, '/cancel', { id })).status !== 204) throw clientError('invalid_response'); }
export async function revealPassword(csrf: string, id: string): Promise<string> {
  const data: unknown = await (await post(csrf, '/reveal', { id })).json();
  if (!record(data) || typeof data.password !== 'string' || data.password.length < 1 || new TextEncoder().encode(data.password).length > 4096 || /[\p{Cc}\p{Cf}]/u.test(data.password)) throw clientError('invalid_response');
  return data.password;
}
export async function inspectInvitation(csrf: string, invitation: string): Promise<Destination> {
  const data: unknown = await (await post(csrf, '/inspect', { invitation })).json();
  if (!record(data) || !origin(data.origin) || !fingerprint(data.fingerprint)) throw clientError('invalid_response');
  return { origin: data.origin, fingerprint: data.fingerprint };
}
export async function sendPassword(csrf: string, invitation: string, password: string) {
  if ((await post(csrf, '/send', { invitation, password, confirmed: true })).status !== 204) throw clientError('invalid_response');
}

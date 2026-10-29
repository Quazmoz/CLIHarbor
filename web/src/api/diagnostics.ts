import { clientError, errorFromResponse } from './errors';
import { fetchWithDeadline, READ_TIMEOUTS } from './http';

export interface DiagnosticReport { json: string; sha256: string; }
const maxBytes = 64 * 1024;
function invalid(): never { throw clientError('invalid_response'); }
const token = (value: unknown, optional = false): value is string => typeof value === 'string' &&
  (optional || value.length > 0) && /^[A-Za-z0-9.+_-]{0,128}$/.test(value);
const count = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;

function record(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  const result = value as Record<string, unknown>;
  if (required.some((key) => !Object.hasOwn(result, key)) || Object.keys(result).some((key) => !required.includes(key) && !optional.includes(key))) invalid();
  return result;
}

function validateBundle(value: unknown): void {
  const bundle = record(value, ['schemaVersion', 'cliharbor', 'runtime', 'configuration', 'health', 'packs', 'tools']);
  if (bundle.schemaVersion !== 'cliharbor.diagnostics/v1') invalid();
  const build = record(bundle.cliharbor, ['version', 'commit', 'buildMode']);
  if (Object.values(build).some((value) => !token(value))) invalid();
  const runtime = record(bundle.runtime, ['goVersion', 'os', 'architecture'], ['osVersion']);
  if (Object.entries(runtime).some(([key, value]) => !token(value, key === 'osVersion'))) invalid();
  const configuration = record(bundle.configuration, ['packSourceMode', 'packCount', 'toolOverrideCount']);
  if (typeof configuration.packSourceMode !== 'string' || !['none', 'files', 'directory'].includes(configuration.packSourceMode) ||
      !count(configuration.packCount, 64) || !count(configuration.toolOverrideCount, 256)) invalid();
  const health = record(bundle.health, ['toolsReady', 'toolsUnavailable']);
  if (!count(health.toolsReady, 256) || !count(health.toolsUnavailable, 256)) invalid();
  const packs = bundle.packs === null ? [] : bundle.packs;
  const tools = bundle.tools === null ? [] : bundle.tools;
  if (!Array.isArray(packs) || packs.length > 64 || configuration.packCount !== packs.length ||
      !Array.isArray(tools) || tools.length > 256 || health.toolsReady + health.toolsUnavailable !== tools.length) invalid();
  let previous = '';
  for (const value of packs) {
    const pack = record(value, ['id', 'version']);
    if (!token(pack.id) || !token(pack.version) || pack.id <= previous) invalid();
    previous = pack.id;
  }
  previous = '';
  for (const value of tools) {
    const tool = record(value, ['packId', 'packVersion', 'toolId', 'status', 'candidateCount'], ['version']);
    if (!token(tool.packId) || !token(tool.packVersion) || !token(tool.toolId) ||
        (tool.version !== undefined && !token(tool.version, true)) || !count(tool.candidateCount, 64) ||
        typeof tool.status !== 'string' || !['ready', 'missing', 'ambiguous', 'incompatible', 'probe-failed', 'invalid-override', 'identity-failed', 'unsupported-platform'].includes(tool.status)) invalid();
    const key = tool.packId + '/' + tool.toolId;
    if (key <= previous) invalid();
    previous = key;
  }
}

export async function fetchDiagnosticReport(signal?: AbortSignal): Promise<DiagnosticReport> {
  const response = await fetchWithDeadline('/api/v1/diagnostics', {
    credentials: 'same-origin', headers: { Accept: 'application/json' }, signal,
  }, READ_TIMEOUTS.fast);
  if (!response.ok) throw await errorFromResponse(response);
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) invalid();
  let bundle: unknown;
  try { bundle = JSON.parse(text); } catch { invalid(); }
  validateBundle(bundle);
  // The endpoint shares the CLI's deterministic JSON. Reject duplicate keys or
  // other noncanonical bytes instead of exporting text discarded by parsing.
  const json = JSON.stringify(bundle, null, 2) + '\n';
  if (json !== text) invalid();
  const bytes = new TextEncoder().encode(json);
  if (bytes.byteLength > maxBytes) invalid();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return { json, sha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('') };
}

export type ToolStatus =
  | 'ready'
  | 'missing'
  | 'ambiguous'
  | 'incompatible'
  | 'probe-failed'
  | 'invalid-override'
  | 'identity-failed'
  | 'unsupported-platform';

export interface ToolDiagnostic {
  packId: string;
  packName: string;
  packVersion: string;
  toolId: string;
  status: ToolStatus;
  version?: string;
  versionConstraint?: string;
  message?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isToolStatus(value: unknown): value is ToolStatus {
  return (
    value === 'ready' ||
    value === 'missing' ||
    value === 'ambiguous' ||
    value === 'incompatible' ||
    value === 'probe-failed' ||
    value === 'invalid-override' ||
    value === 'identity-failed' ||
    value === 'unsupported-platform'
  );
}

function parseTool(value: unknown): ToolDiagnostic {
  if (!isRecord(value)) {
    throw new Error('CLIHarbor returned invalid tool diagnostics.');
  }
  const { packId, packName, packVersion, toolId, status, version, versionConstraint, message } = value;
  if (
    typeof packId !== 'string' ||
    typeof packName !== 'string' ||
    typeof packVersion !== 'string' ||
    typeof toolId !== 'string' ||
    !isToolStatus(status) ||
    (version !== undefined && typeof version !== 'string') ||
    (versionConstraint !== undefined && typeof versionConstraint !== 'string') ||
    (message !== undefined && typeof message !== 'string')
  ) {
    throw new Error('CLIHarbor returned invalid tool diagnostics.');
  }
  return { packId, packName, packVersion, toolId, status, version, versionConstraint, message };
}

export async function fetchTools(signal?: AbortSignal): Promise<ToolDiagnostic[]> {
  const response = await fetch('/api/v1/tools', {
    method: 'GET',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) {
    throw new Error(`CLIHarbor tool diagnostics request failed with HTTP ${response.status}.`);
  }
  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload.tools)) {
    throw new Error('CLIHarbor returned invalid tool diagnostics.');
  }
  return payload.tools.map(parseTool);
}

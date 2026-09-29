import { clientError, errorFromResponse } from './errors';

export type ToolStatus =
  | 'ready'
  | 'missing'
  | 'ambiguous'
  | 'incompatible'
  | 'probe-failed'
  | 'invalid-override'
  | 'identity-failed'
  | 'unsupported-platform';

export interface VendorSessionCheck {
  commandId: string;
  unauthenticatedStderrContains?: string;
}

export interface CredentialLoginCapability {
  method: 'conjur-password';
}

export interface ToolInstallCapability {
  version: string;
}

export interface ToolInstallResult {
  installed: boolean;
  version: string;
  restartRequired: boolean;
  message: string;
}

export interface ToolDiagnostic {
  packId: string;
  packName: string;
  packVersion: string;
  toolId: string;
  status: ToolStatus;
  version?: string;
  versionConstraint?: string;
  message?: string;
  requiresVendorSession?: boolean;
  sessionCheck?: VendorSessionCheck;
  credentialLogin?: CredentialLoginCapability;
  install?: ToolInstallCapability;
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

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function parseSessionCheck(value: unknown): VendorSessionCheck {
  if (!isRecord(value)) {
    throw clientError('invalid_response');
  }
  const { commandId, unauthenticatedStderrContains } = value;
  if (
    typeof commandId !== 'string' ||
    !/^[a-z][a-z0-9-]{0,62}$/.test(commandId) ||
    (unauthenticatedStderrContains !== undefined &&
      (typeof unauthenticatedStderrContains !== 'string' ||
        unauthenticatedStderrContains.length === 0 ||
        unauthenticatedStderrContains.length > 256 ||
        unauthenticatedStderrContains.trim() !== unauthenticatedStderrContains ||
        hasControlCharacters(unauthenticatedStderrContains)))
  ) {
    throw clientError('invalid_response');
  }
  return { commandId, unauthenticatedStderrContains };
}

function parseInstall(value: unknown): ToolInstallCapability {
  if (!isRecord(value) || Object.keys(value).length !== 1 || typeof value.version !== 'string' || value.version.length === 0 || value.version.length > 128) {
    throw clientError('invalid_response');
  }
  return { version: value.version };
}

function parseCredentialLogin(value: unknown): CredentialLoginCapability {
  if (!isRecord(value) || Object.keys(value).length !== 1 || value.method !== 'conjur-password') {
    throw clientError('invalid_response');
  }
  return { method: 'conjur-password' };
}

function parseTool(value: unknown): ToolDiagnostic {
  if (!isRecord(value)) {
    throw clientError('invalid_response');
  }
  const {
    packId,
    packName,
    packVersion,
    toolId,
    status,
    version,
    versionConstraint,
    message,
    requiresVendorSession,
    sessionCheck,
    credentialLogin,
    install,
  } = value;
  if (
    typeof packId !== 'string' ||
    typeof packName !== 'string' ||
    typeof packVersion !== 'string' ||
    typeof toolId !== 'string' ||
    !isToolStatus(status) ||
    (version !== undefined && typeof version !== 'string') ||
    (versionConstraint !== undefined && typeof versionConstraint !== 'string') ||
    (message !== undefined && typeof message !== 'string') ||
    (requiresVendorSession !== undefined && typeof requiresVendorSession !== 'boolean')
  ) {
    throw clientError('invalid_response');
  }
  const parsedSessionCheck = sessionCheck === undefined ? undefined : parseSessionCheck(sessionCheck);
  const parsedCredentialLogin =
    credentialLogin === undefined ? undefined : parseCredentialLogin(credentialLogin);
  const parsedInstall = install === undefined ? undefined : parseInstall(install);
  if (
    (parsedSessionCheck !== undefined || parsedCredentialLogin !== undefined) &&
    requiresVendorSession !== true
  ) {
    throw clientError('invalid_response');
  }

  return {
    packId,
    packName,
    packVersion,
    toolId,
    status,
    version,
    versionConstraint,
    message,
    requiresVendorSession: requiresVendorSession === true,
    sessionCheck: parsedSessionCheck,
    credentialLogin: parsedCredentialLogin,
    install: parsedInstall,
  };
}

export async function fetchTools(signal?: AbortSignal): Promise<ToolDiagnostic[]> {
  const response = await fetch('/api/v1/tools', {
    method: 'GET',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) {
    throw await errorFromResponse(response);
  }
  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload.tools)) {
    throw clientError('invalid_response');
  }
  return payload.tools.map(parseTool);
}


export async function installTool(
  csrfToken: string,
  packId: string,
  toolId: string,
  signal?: AbortSignal,
): Promise<ToolInstallResult> {
  const response = await fetch('/api/v1/tools/install', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-CLIHarbor-CSRF': csrfToken,
    },
    body: JSON.stringify({ packId, toolId }),
    signal,
  });
  if (!response.ok) {
    throw await errorFromResponse(response);
  }
  const payload: unknown = await response.json();
  if (
    !isRecord(payload) ||
    typeof payload.installed !== 'boolean' ||
    typeof payload.version !== 'string' ||
    typeof payload.restartRequired !== 'boolean' ||
    typeof payload.message !== 'string' ||
    payload.version.length === 0 ||
    payload.version.length > 128 ||
    payload.message.length === 0 ||
    payload.message.length > 512
  ) {
    throw clientError('invalid_response');
  }
  return {
    installed: payload.installed,
    version: payload.version,
    restartRequired: payload.restartRequired,
    message: payload.message,
  };
}

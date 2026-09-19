export type AppErrorCategory =
  | 'validation'
  | 'security'
  | 'discovery'
  | 'policy'
  | 'capacity'
  | 'lifecycle'
  | 'stream'
  | 'execution'
  | 'internal';

export type ServerErrorCode =
  | 'invalid_request'
  | 'invalid_input'
  | 'request_too_large'
  | 'method_not_allowed'
  | 'request_forbidden'
  | 'session_unavailable'
  | 'resource_not_found'
  | 'command_blocked'
  | 'tool_unavailable'
  | 'tool_changed'
  | 'run_capacity'
  | 'run_not_found'
  | 'runtime_closed'
  | 'invalid_cursor'
  | 'stream_capacity'
  | 'stream_unavailable'
  | 'execution_failed'
  | 'output_limit'
  | 'event_capacity'
  | 'internal_error';

export type ClientErrorCode = 'network_unavailable' | 'invalid_response' | 'stream_disconnected';
export type AppErrorCode = ServerErrorCode | ClientErrorCode;

export interface AppErrorDetail {
  code: AppErrorCode;
  category: AppErrorCategory;
  message: string;
  remediation?: string;
  retryable: boolean;
  field?: string;
}

export class AppError extends Error {
  readonly detail: AppErrorDetail;

  constructor(detail: AppErrorDetail) {
    super(detail.message);
    this.name = 'AppError';
    this.detail = detail;
  }
}

const serverCodeCategories: Record<ServerErrorCode, AppErrorCategory> = {
  invalid_request: 'validation',
  invalid_input: 'validation',
  request_too_large: 'validation',
  method_not_allowed: 'validation',
  request_forbidden: 'security',
  session_unavailable: 'security',
  resource_not_found: 'lifecycle',
  command_blocked: 'policy',
  tool_unavailable: 'discovery',
  tool_changed: 'discovery',
  run_capacity: 'capacity',
  run_not_found: 'lifecycle',
  runtime_closed: 'lifecycle',
  invalid_cursor: 'stream',
  stream_capacity: 'capacity',
  stream_unavailable: 'stream',
  execution_failed: 'execution',
  output_limit: 'execution',
  event_capacity: 'execution',
  internal_error: 'internal',
};

function isServerErrorCode(value: string): value is ServerErrorCode {
  return Object.prototype.hasOwnProperty.call(serverCodeCategories, value);
}

const clientDetails: Record<ClientErrorCode, AppErrorDetail> = {
  network_unavailable: {
    code: 'network_unavailable',
    category: 'lifecycle',
    message: 'CLIHarbor could not reach the local runtime.',
    remediation: 'Confirm CLIHarbor is still running, then retry.',
    retryable: true,
  },
  invalid_response: {
    code: 'invalid_response',
    category: 'internal',
    message: 'CLIHarbor returned an invalid or unsupported local response.',
    remediation: 'Relaunch CLIHarbor before retrying this operation.',
    retryable: false,
  },
  stream_disconnected: {
    code: 'stream_disconnected',
    category: 'stream',
    message: 'Live run updates stopped after repeated disconnects.',
    remediation: 'CLIHarbor refreshed retained run state. Retry live updates only if the run is still active.',
    retryable: true,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function safeDisplayText(value: unknown, maxLength: number): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    return false;
  }
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) {
      return false;
    }
  }
  return true;
}

function safeField(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (value === 'packId' || value === 'commandId' || /^values\.[a-z][a-z0-9-]{0,62}$/u.test(value))
  );
}

export function parseServerErrorDetail(value: unknown): AppErrorDetail | null {
  if (!isRecord(value)) {
    return null;
  }
  const allowed = new Set(['code', 'category', 'message', 'remediation', 'retryable', 'field']);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    return null;
  }
  const { code, category, message, remediation, retryable, field } = value;
  if (
    typeof code !== 'string' ||
    !isServerErrorCode(code) ||
    typeof category !== 'string' ||
    category !== serverCodeCategories[code] ||
    !safeDisplayText(message, 512) ||
    (remediation !== undefined && !safeDisplayText(remediation, 512)) ||
    typeof retryable !== 'boolean' ||
    (field !== undefined && !safeField(field))
  ) {
    return null;
  }
  return {
    code,
    category: serverCodeCategories[code],
    message,
    remediation,
    retryable,
    field,
  };
}

export function clientError(code: ClientErrorCode): AppError {
  return new AppError({ ...clientDetails[code] });
}

export function invalidInputError(field: string): AppError {
  const base: AppErrorDetail = {
    code: 'invalid_input',
    category: 'validation',
    message: 'One or more task inputs are invalid.',
    remediation: 'Correct the highlighted field and retry.',
    retryable: false,
  };
  if (safeField(field)) {
    base.field = field;
  }
  return new AppError(base);
}

export function normalizeError(error: unknown, fallback: ClientErrorCode = 'network_unavailable'): AppError {
  return error instanceof AppError ? error : clientError(fallback);
}

export async function errorFromResponse(response: Response): Promise<AppError> {
  try {
    const payload: unknown = await response.json();
    if (!isRecord(payload)) {
      return clientError('invalid_response');
    }
    const detail = parseServerErrorDetail(payload.error);
    return detail === null ? clientError('invalid_response') : new AppError(detail);
  } catch {
    return clientError('invalid_response');
  }
}

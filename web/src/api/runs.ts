import type { TaskImpactScope, TaskRisk } from './tasks';
import {
  clientError,
  errorFromResponse,
  parseServerErrorDetail,
  type AppError,
  type AppErrorDetail,
} from './errors';

export type RunStatus = 'running' | 'exited' | 'cancelled' | 'timed-out' | 'failed';

export interface RunEvent {
  runId: string;
  sequence: number;
  type: string;
  timestamp: string;
  dataBase64?: string;
  exitCode?: number;
}

export interface RunComplete {
  runId: string;
  sequence: number;
  status: RunStatus;
  exitCode?: number;
  structured?: StructuredResult;
  failure?: AppErrorDetail;
}

export type StructuredStatus = 'available' | 'invalid' | 'unavailable';
export type StructuredFieldType = 'string' | 'integer' | 'boolean';
export type StructuredErrorCode =
  | 'invalid_encoding'
  | 'output_too_large'
  | 'malformed_json'
  | 'unexpected_schema'
  | 'duplicate_key'
  | 'unexpected_field'
  | 'missing_field'
  | 'wrong_type'
  | 'invalid_integer'
  | 'string_too_large'
  | 'unsafe_control'
  | 'parser_cancelled'
  | 'nonzero_exit'
  | 'run_cancelled'
  | 'run_timed_out'
  | 'execution_failed'
  | 'sensitive_output'
  | 'unknown';

export interface StructuredField {
  key: string;
  label: string;
  type: StructuredFieldType;
  present: boolean;
  value: string;
}

export interface StructuredResult {
  status: StructuredStatus;
  renderer: 'cards';
  error?: StructuredErrorCode;
  fields?: StructuredField[];
}

export interface RunSnapshot {
  runId: string;
  packId: string;
  commandId: string;
  toolId: string;
  toolVersion?: string;
  status: RunStatus;
  startedAt?: string;
  endedAt?: string;
  exitCode?: number;
  structured?: StructuredResult;
  failure?: AppErrorDetail;
  events?: Array<Omit<RunEvent, 'runId'>>;
}

export interface RunSummary {
  runId: string;
  packId: string;
  commandId: string;
  toolId: string;
  toolVersion?: string;
  status: RunStatus;
  startedAt?: string;
  endedAt?: string;
  exitCode?: number;
}

export interface RunApprovalSubmission {
  id: string;
  confirmation?: string;
}

export interface CreateRunRequest {
  packId: string;
  commandId: string;
  values: Record<string, unknown>;
  approval?: RunApprovalSubmission;
}

export interface RunMutationImpact {
  targetLabel: string;
  target: string;
  effect: string;
  scope: TaskImpactScope;
}

export interface RunExecutionContextField {
  label: string;
  value: string;
}

export interface RunExecutionContext {
  fields: RunExecutionContextField[];
}

export interface RunApprovalChallenge {
  id: string;
  expiresAt: string;
  mode: 'explicit' | 'typed';
  requiredText?: string;
}

export interface RunPreview {
  packId: string;
  commandId: string;
  toolId: string;
  toolVersion?: string;
  executableName: string;
  args: string[];
  stdin?: string;
  risk: TaskRisk;
  impact?: RunMutationImpact;
  context?: RunExecutionContext;
  approval?: RunApprovalChallenge;
}

const structuredErrorCodes = new Set<StructuredErrorCode>([
  'invalid_encoding',
  'output_too_large',
  'malformed_json',
  'unexpected_schema',
  'duplicate_key',
  'unexpected_field',
  'missing_field',
  'wrong_type',
  'invalid_integer',
  'string_too_large',
  'unsafe_control',
  'parser_cancelled',
  'nonzero_exit',
  'run_cancelled',
  'run_timed_out',
  'execution_failed',
  'sensitive_output',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function invalidResponse(): never {
  throw clientError('invalid_response');
}

function isRunStatus(value: unknown): value is RunStatus {
  return value === 'running' || value === 'exited' || value === 'cancelled' || value === 'timed-out' || value === 'failed';
}

function parseStructuredError(value: unknown): StructuredErrorCode | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    invalidResponse();
  }
  return structuredErrorCodes.has(value as StructuredErrorCode) ? (value as StructuredErrorCode) : 'unknown';
}

function parseStructured(value: unknown): StructuredResult {
  if (!isRecord(value)) {
    invalidResponse();
  }
  const allowed = new Set(['status', 'renderer', 'error', 'fields']);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    invalidResponse();
  }
  const { status, renderer, error, fields } = value;
  if (
    !['available', 'invalid', 'unavailable'].includes(String(status)) ||
    renderer !== 'cards' ||
    (fields !== undefined && !Array.isArray(fields))
  ) {
    invalidResponse();
  }
  const parsedFields = Array.isArray(fields)
    ? fields.map((field): StructuredField => {
        if (!isRecord(field)) {
          invalidResponse();
        }
        const fieldAllowed = new Set(['key', 'label', 'type', 'present', 'value']);
        if (Object.keys(field).some((key) => !fieldAllowed.has(key))) {
          invalidResponse();
        }
        const { key, label, type, present, value: fieldValue } = field;
        if (
          typeof key !== 'string' ||
          typeof label !== 'string' ||
          !['string', 'integer', 'boolean'].includes(String(type)) ||
          typeof present !== 'boolean' ||
          typeof fieldValue !== 'string'
        ) {
          invalidResponse();
        }
        return { key, label, type: type as StructuredFieldType, present, value: fieldValue };
      })
    : undefined;
  if (status === 'available' && parsedFields === undefined) {
    invalidResponse();
  }
  return {
    status: status as StructuredStatus,
    renderer: 'cards',
    error: parseStructuredError(error),
    fields: parsedFields,
  };
}

function parseFailure(value: unknown): AppErrorDetail | undefined {
  if (value === undefined) {
    return undefined;
  }
  return parseServerErrorDetail(value) ?? clientError('invalid_response').detail;
}

function parseSnapshot(value: unknown): RunSnapshot {
  if (!isRecord(value)) {
    invalidResponse();
  }
  const allowed = new Set([
    'runId',
    'packId',
    'commandId',
    'toolId',
    'toolVersion',
    'status',
    'startedAt',
    'endedAt',
    'exitCode',
    'structured',
    'failure',
    'events',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    invalidResponse();
  }
  const {
    runId,
    packId,
    commandId,
    toolId,
    toolVersion,
    status,
    startedAt,
    endedAt,
    exitCode,
    structured,
    failure,
    events,
  } = value;
  if (
    typeof runId !== 'string' ||
    typeof packId !== 'string' ||
    typeof commandId !== 'string' ||
    typeof toolId !== 'string' ||
    (toolVersion !== undefined && typeof toolVersion !== 'string') ||
    !isRunStatus(status) ||
    (startedAt !== undefined && typeof startedAt !== 'string') ||
    (endedAt !== undefined && typeof endedAt !== 'string') ||
    (exitCode !== undefined && typeof exitCode !== 'number') ||
    (structured !== undefined && !isRecord(structured)) ||
    (failure !== undefined && !isRecord(failure)) ||
    (events !== undefined && !Array.isArray(events))
  ) {
    invalidResponse();
  }
  return {
    runId,
    packId,
    commandId,
    toolId,
    toolVersion,
    status,
    startedAt,
    endedAt,
    exitCode,
    structured: structured === undefined ? undefined : parseStructured(structured),
    failure: parseFailure(failure),
    events: Array.isArray(events)
      ? events.map((event) => {
          if (!isRecord(event)) {
            invalidResponse();
          }
          const parsed = parseEvent({ ...event, runId });
          return {
            sequence: parsed.sequence,
            type: parsed.type,
            timestamp: parsed.timestamp,
            dataBase64: parsed.dataBase64,
            exitCode: parsed.exitCode,
          };
        })
      : undefined,
  };
}

function parseRunSummary(value: unknown): RunSummary {
  if (!isRecord(value)) {
    invalidResponse();
  }
  const allowed = new Set([
    'runId',
    'packId',
    'commandId',
    'toolId',
    'toolVersion',
    'status',
    'startedAt',
    'endedAt',
    'exitCode',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    invalidResponse();
  }
  const { runId, packId, commandId, toolId, toolVersion, status, startedAt, endedAt, exitCode } = value;
  if (
    typeof runId !== 'string' ||
    typeof packId !== 'string' ||
    typeof commandId !== 'string' ||
    typeof toolId !== 'string' ||
    (toolVersion !== undefined && typeof toolVersion !== 'string') ||
    !isRunStatus(status) ||
    (startedAt !== undefined && typeof startedAt !== 'string') ||
    (endedAt !== undefined && typeof endedAt !== 'string') ||
    (exitCode !== undefined && typeof exitCode !== 'number')
  ) {
    invalidResponse();
  }
  return { runId, packId, commandId, toolId, toolVersion, status, startedAt, endedAt, exitCode };
}

function parsePreview(value: unknown): RunPreview {
  if (!isRecord(value)) {
    invalidResponse();
  }
  const allowed = new Set([
    'packId',
    'commandId',
    'toolId',
    'toolVersion',
    'executableName',
    'args',
    'stdin',
    'risk',
    'impact',
    'context',
    'approval',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    invalidResponse();
  }
  const { packId, commandId, toolId, toolVersion, executableName, args, stdin, risk, impact, context, approval } = value;
  if (
    typeof packId !== 'string' ||
    typeof commandId !== 'string' ||
    typeof toolId !== 'string' ||
    (toolVersion !== undefined && typeof toolVersion !== 'string') ||
    typeof executableName !== 'string' ||
    executableName.length === 0 ||
    executableName.length > 128 ||
    !Array.isArray(args) ||
    args.length > 256 ||
    args.some((arg) => typeof arg !== 'string' || arg.length > 4096) ||
    (stdin !== undefined && (typeof stdin !== 'string' || stdin.length > 65_536)) ||
    (risk !== undefined && !['read', 'change', 'destructive'].includes(String(risk)))
  ) {
    invalidResponse();
  }

  const parsedRisk = (risk ?? 'read') as TaskRisk;
  let parsedImpact: RunMutationImpact | undefined;
  if (impact !== undefined) {
    if (!isRecord(impact) || Object.keys(impact).some((key) => !['targetLabel', 'target', 'effect', 'scope'].includes(key))) {
      invalidResponse();
    }
    const { targetLabel, target, effect, scope } = impact;
    if (
      typeof targetLabel !== 'string' ||
      typeof target !== 'string' ||
      typeof effect !== 'string' ||
      !['single', 'multiple'].includes(String(scope))
    ) {
      invalidResponse();
    }
    parsedImpact = { targetLabel, target, effect, scope: scope as TaskImpactScope };
  }

  let parsedContext: RunExecutionContext | undefined;
  if (context !== undefined) {
    if (!isRecord(context) || Object.keys(context).some((key) => key !== 'fields') || !Array.isArray(context.fields)) {
      invalidResponse();
    }
    if (context.fields.length < 1 || context.fields.length > 8) {
      invalidResponse();
    }
    parsedContext = {
      fields: context.fields.map((field) => {
        if (!isRecord(field) || Object.keys(field).some((key) => !['label', 'value'].includes(key))) {
          invalidResponse();
        }
        const { label, value: fieldValue } = field;
        if (typeof label !== 'string' || typeof fieldValue !== 'string' || label.length === 0 || label.length > 80 || fieldValue.length === 0 || fieldValue.length > 2048) {
          invalidResponse();
        }
        return { label, value: fieldValue };
      }),
    };
  }

  let parsedApproval: RunApprovalChallenge | undefined;
  if (approval !== undefined) {
    if (!isRecord(approval) || Object.keys(approval).some((key) => !['id', 'expiresAt', 'mode', 'requiredText'].includes(key))) {
      invalidResponse();
    }
    const { id, expiresAt, mode, requiredText } = approval;
    if (
      typeof id !== 'string' ||
      !/^[0-9a-f]{32}$/u.test(id) ||
      typeof expiresAt !== 'string' ||
      Number.isNaN(Date.parse(expiresAt)) ||
      !['explicit', 'typed'].includes(String(mode)) ||
      (requiredText !== undefined && typeof requiredText !== 'string')
    ) {
      invalidResponse();
    }
    if ((mode === 'typed') !== (typeof requiredText === 'string' && requiredText.length > 0 && requiredText.length <= 4096)) {
      invalidResponse();
    }
    parsedApproval = {
      id,
      expiresAt,
      mode: mode as 'explicit' | 'typed',
      requiredText,
    };
  }

  const mutation = parsedRisk === 'change' || parsedRisk === 'destructive';
  if (mutation !== (parsedImpact !== undefined && parsedContext !== undefined && parsedApproval !== undefined)) {
    invalidResponse();
  }
  if (!mutation && (parsedImpact !== undefined || parsedContext !== undefined || parsedApproval !== undefined)) {
    invalidResponse();
  }

  return {
    packId,
    commandId,
    toolId,
    toolVersion,
    executableName,
    args: [...args] as string[],
    ...(typeof stdin === 'string' ? { stdin } : {}),
    risk: parsedRisk,
    impact: parsedImpact,
    context: parsedContext,
    approval: parsedApproval,
  };
}

function parseEvent(value: unknown): RunEvent {
  if (!isRecord(value)) {
    invalidResponse();
  }
  const allowed = new Set(['runId', 'sequence', 'type', 'timestamp', 'dataBase64', 'exitCode']);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    invalidResponse();
  }
  const { runId, sequence, type, timestamp, dataBase64, exitCode } = value;
  if (
    typeof runId !== 'string' ||
    typeof sequence !== 'number' ||
    !Number.isSafeInteger(sequence) ||
    sequence < 0 ||
    typeof type !== 'string' ||
    typeof timestamp !== 'string' ||
    (dataBase64 !== undefined && typeof dataBase64 !== 'string') ||
    (exitCode !== undefined && typeof exitCode !== 'number')
  ) {
    invalidResponse();
  }
  if (dataBase64 !== undefined) {
    decodeBase64Text(dataBase64);
  }
  return { runId, sequence, type, timestamp, dataBase64, exitCode };
}

function parseComplete(value: unknown): RunComplete {
  if (!isRecord(value)) {
    invalidResponse();
  }
  const allowed = new Set(['runId', 'sequence', 'status', 'exitCode', 'structured', 'failure']);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    invalidResponse();
  }
  const { runId, sequence, status, exitCode, structured, failure } = value;
  if (
    typeof runId !== 'string' ||
    typeof sequence !== 'number' ||
    !Number.isSafeInteger(sequence) ||
    sequence < 0 ||
    !isRunStatus(status) ||
    (exitCode !== undefined && typeof exitCode !== 'number') ||
    (structured !== undefined && !isRecord(structured)) ||
    (failure !== undefined && !isRecord(failure))
  ) {
    invalidResponse();
  }
  return {
    runId,
    sequence,
    status,
    exitCode,
    structured: structured === undefined ? undefined : parseStructured(structured),
    failure: parseFailure(failure),
  };
}

async function mutation(path: string, csrfToken: string, body?: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-CLIHarbor-CSRF': csrfToken,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw await errorFromResponse(response);
  }
  return response.json();
}

export async function previewRun(csrfToken: string, request: CreateRunRequest): Promise<RunPreview> {
  return parsePreview(await mutation('/api/v1/runs/preview', csrfToken, request));
}

export async function createRun(csrfToken: string, request: CreateRunRequest): Promise<RunSnapshot> {
  return parseSnapshot(await mutation('/api/v1/runs', csrfToken, request));
}

export async function cancelRun(csrfToken: string, runId: string): Promise<RunSnapshot> {
  return parseSnapshot(await mutation(`/api/v1/runs/${encodeURIComponent(runId)}/cancel`, csrfToken));
}

export async function fetchRuns(signal?: AbortSignal): Promise<RunSummary[]> {
  const response = await fetch('/api/v1/runs', {
    method: 'GET',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) {
    throw await errorFromResponse(response);
  }
  const payload: unknown = await response.json();
  if (!isRecord(payload) || Object.keys(payload).some((key) => key !== 'runs') || !Array.isArray(payload.runs)) {
    invalidResponse();
  }
  if (payload.runs.length > 256) {
    invalidResponse();
  }
  return payload.runs.map(parseRunSummary);
}

export async function fetchRun(runId: string, signal?: AbortSignal): Promise<RunSnapshot> {
  const response = await fetch(`/api/v1/runs/${encodeURIComponent(runId)}`, {
    method: 'GET',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) {
    throw await errorFromResponse(response);
  }
  return parseSnapshot(await response.json());
}

const maxStreamFailures = 5;

export function subscribeRunEvents(
  runId: string,
  onEvent: (event: RunEvent) => void,
  onComplete: (complete: RunComplete) => void,
  onError: (error: AppError) => void,
  onOpen?: () => void,
  afterSequence = 0,
): () => void {
  const source = new EventSource(`/api/v1/runs/${encodeURIComponent(runId)}/events`);
  let failures = 0;
  let closed = false;
  let lastSequence = afterSequence;

  const failClosed = (error: unknown) => {
    closed = true;
    source.close();
    onError(error instanceof Error && error.name === 'AppError' ? (error as AppError) : clientError('invalid_response'));
  };

  const handleEvent = (raw: Event) => {
    if (closed) return;
    try {
      const event = parseEvent(JSON.parse((raw as MessageEvent<string>).data));
      if (event.runId !== runId) throw clientError('invalid_response');
      if (event.sequence <= lastSequence) return;
      onEvent(event);
      lastSequence = event.sequence;
      failures = 0;
    } catch (error) {
      failClosed(error);
    }
  };
  const handleComplete = (raw: Event) => {
    if (closed) return;
    try {
      const complete = parseComplete(JSON.parse((raw as MessageEvent<string>).data));
      if (complete.runId !== runId || complete.sequence < lastSequence || complete.status === 'running') throw clientError('invalid_response');
      onComplete(complete);
    } catch (error) {
      onError(error instanceof Error && error.name === 'AppError' ? (error as AppError) : clientError('invalid_response'));
    } finally {
      closed = true;
      source.close();
    }
  };

  source.addEventListener('run-event', handleEvent);
  source.addEventListener('run-complete', handleComplete);
  source.onopen = () => {
    if (closed) return;
    // Opening a connection is not evidence of progress; empty reconnects must
    // still exhaust the retry budget.
    onOpen?.();
  };
  source.onerror = () => {
    if (closed) {
      return;
    }
    failures += 1;
    // A CLOSED EventSource cannot reconnect, so reconcile immediately.
    if (source.readyState !== 2 && failures < maxStreamFailures) {
      return;
    }
    closed = true;
    source.close();
    onError(clientError('stream_disconnected'));
  };

  return () => {
    closed = true;
    source.close();
  };
}

export function decodeBase64Text(value: string, decoder = new TextDecoder(), stream = false): string {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return decoder.decode(bytes, { stream });
}

export function decodeRunOutput(snapshot: RunSnapshot, stream: 'stdout.chunk' | 'stderr.chunk'): string {
  const decoder = new TextDecoder();
  let output = '';
  for (const event of snapshot.events ?? []) {
    if (event.type === stream && event.dataBase64 !== undefined) {
      output += decodeBase64Text(event.dataBase64, decoder, true);
    }
  }
  return output + (snapshot.status === 'running' ? '' : decoder.decode());
}

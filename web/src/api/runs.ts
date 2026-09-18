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
  events?: Array<Omit<RunEvent, 'runId'>>;
}

export interface CreateRunRequest {
  packId: string;
  commandId: string;
  values: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRunStatus(value: unknown): value is RunStatus {
  return value === 'running' || value === 'exited' || value === 'cancelled' || value === 'timed-out' || value === 'failed';
}

function parseSnapshot(value: unknown): RunSnapshot {
  if (!isRecord(value)) {
    throw new Error('CLIHarbor returned an invalid run response.');
  }
  const { runId, packId, commandId, toolId, toolVersion, status, startedAt, endedAt, exitCode, events } = value;
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
    (events !== undefined && !Array.isArray(events))
  ) {
    throw new Error('CLIHarbor returned an invalid run response.');
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
    events: Array.isArray(events)
      ? events.map((event) => {
          const parsed = parseEvent({ ...event, runId });
          const { runId: _runId, ...rest } = parsed;
          return rest;
        })
      : undefined,
  };
}

function parseEvent(value: unknown): RunEvent {
  if (!isRecord(value)) {
    throw new Error('CLIHarbor returned an invalid run event.');
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
    throw new Error('CLIHarbor returned an invalid run event.');
  }
  return { runId, sequence, type, timestamp, dataBase64, exitCode };
}

function parseComplete(value: unknown): RunComplete {
  if (!isRecord(value)) {
    throw new Error('CLIHarbor returned an invalid run completion event.');
  }
  const { runId, sequence, status, exitCode } = value;
  if (
    typeof runId !== 'string' ||
    typeof sequence !== 'number' ||
    !Number.isSafeInteger(sequence) ||
    sequence < 0 ||
    !isRunStatus(status) ||
    (exitCode !== undefined && typeof exitCode !== 'number')
  ) {
    throw new Error('CLIHarbor returned an invalid run completion event.');
  }
  return { runId, sequence, status, exitCode };
}

async function mutation<T>(path: string, csrfToken: string, body?: unknown): Promise<T> {
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
    throw new Error(`CLIHarbor run request failed with HTTP ${response.status}.`);
  }
  return (await response.json()) as T;
}

export async function createRun(csrfToken: string, request: CreateRunRequest): Promise<RunSnapshot> {
  return parseSnapshot(await mutation<unknown>('/api/v1/runs', csrfToken, request));
}

export async function cancelRun(csrfToken: string, runId: string): Promise<RunSnapshot> {
  return parseSnapshot(await mutation<unknown>(`/api/v1/runs/${encodeURIComponent(runId)}/cancel`, csrfToken));
}

export async function fetchRun(runId: string): Promise<RunSnapshot> {
  const response = await fetch(`/api/v1/runs/${encodeURIComponent(runId)}`, {
    method: 'GET',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`CLIHarbor run status request failed with HTTP ${response.status}.`);
  }
  return parseSnapshot(await response.json());
}

export function subscribeRunEvents(
  runId: string,
  onEvent: (event: RunEvent) => void,
  onComplete: (complete: RunComplete) => void,
  onError: (error: Error) => void,
): () => void {
  const source = new EventSource(`/api/v1/runs/${encodeURIComponent(runId)}/events`);

  const handleEvent = (raw: Event) => {
    try {
      onEvent(parseEvent(JSON.parse((raw as MessageEvent<string>).data)));
    } catch (error) {
      onError(error instanceof Error ? error : new Error('CLIHarbor returned an invalid run event.'));
      source.close();
    }
  };
  const handleComplete = (raw: Event) => {
    try {
      onComplete(parseComplete(JSON.parse((raw as MessageEvent<string>).data)));
    } catch (error) {
      onError(error instanceof Error ? error : new Error('CLIHarbor returned an invalid run completion event.'));
    } finally {
      source.close();
    }
  };

  source.addEventListener('run-event', handleEvent);
  source.addEventListener('run-complete', handleComplete);
  source.onerror = () => {
    onError(new Error('Live run stream disconnected; CLIHarbor will retry while the run remains retained.'));
  };

  return () => source.close();
}

export function decodeBase64Text(value: string): string {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { fetchRuntimeStatus, SessionUnavailableError, type RuntimeStatus } from './api/status';
import { fetchTasks, type Task, type TaskInput } from './api/tasks';
import {
  cancelRun,
  createRun,
  decodeBase64Text,
  subscribeRunEvents,
  type RunComplete,
  type RunEvent,
  type RunSnapshot,
} from './api/runs';

type ViewState =
  | { kind: 'loading' }
  | { kind: 'ready'; status: RuntimeStatus; tasks: Task[] }
  | { kind: 'error'; message: string; sessionUnavailable: boolean };

type FormValue = string | boolean | string[];

interface RunView {
  snapshot: RunSnapshot;
  stdout: string;
  stderr: string;
  streamMessage: string;
  lastSequence: number;
}

function errorMessage(error: unknown): { message: string; sessionUnavailable: boolean } {
  if (error instanceof SessionUnavailableError) {
    return { message: error.message, sessionUnavailable: true };
  }
  if (error instanceof Error && error.message.length > 0) {
    return { message: error.message, sessionUnavailable: false };
  }
  return { message: 'CLIHarbor could not load local runtime status.', sessionUnavailable: false };
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

async function loadRuntime(signal?: AbortSignal): Promise<{ status: RuntimeStatus; tasks: Task[] }> {
  const status = await fetchRuntimeStatus(signal);
  const tasks = await fetchTasks(signal);
  return { status, tasks };
}

function initialValues(task: Task | undefined): Record<string, FormValue> {
  const values: Record<string, FormValue> = {};
  for (const input of task?.inputs ?? []) {
    switch (input.type) {
      case 'boolean':
        values[input.id] = false;
        break;
      case 'multiselect':
        values[input.id] = [];
        break;
      case 'enum':
        values[input.id] = input.required ? (input.validation?.enum?.[0] ?? '') : '';
        break;
      default:
        values[input.id] = '';
    }
  }
  return values;
}

function requestValues(task: Task, formValues: Record<string, FormValue>): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const input of task.inputs) {
    const value = formValues[input.id];
    if (input.type === 'boolean') {
      values[input.id] = value === true;
      continue;
    }
    if (input.type === 'multiselect') {
      const selected = Array.isArray(value) ? value : [];
      if (input.required || selected.length > 0) {
        values[input.id] = selected;
      }
      continue;
    }
    const text = typeof value === 'string' ? value : '';
    if (!input.required && text.length === 0) {
      continue;
    }
    values[input.id] = input.type === 'integer' ? Number(text) : text;
  }
  return values;
}

function appendRunEvent(current: RunView, event: RunEvent): RunView {
  if (event.runId !== current.snapshot.runId || event.sequence <= current.lastSequence) {
    return current;
  }
  let stdout = current.stdout;
  let stderr = current.stderr;
  if (event.dataBase64 !== undefined) {
    const text = decodeBase64Text(event.dataBase64);
    if (event.type === 'stdout.chunk') {
      stdout += text;
    } else if (event.type === 'stderr.chunk') {
      stderr += text;
    }
  }
  return {
    ...current,
    stdout,
    stderr,
    streamMessage: '',
    lastSequence: event.sequence,
  };
}

function completeRun(current: RunView, complete: RunComplete): RunView {
  if (complete.runId !== current.snapshot.runId) {
    return current;
  }
  return {
    ...current,
    snapshot: {
      ...current.snapshot,
      status: complete.status,
      exitCode: complete.exitCode,
    },
    streamMessage: '',
    lastSequence: Math.max(current.lastSequence, complete.sequence),
  };
}

function InputControl({
  input,
  value,
  onChange,
}: {
  input: TaskInput;
  value: FormValue | undefined;
  onChange: (value: FormValue) => void;
}) {
  const validation = input.validation ?? {};
  if (input.type === 'boolean') {
    return (
      <label className="checkbox-row">
        <input type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} />
        <span>{input.label}</span>
      </label>
    );
  }

  if (input.type === 'enum') {
    return (
      <label className="field">
        <span>{input.label}</span>
        <select
          required={input.required}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value)}
        >
          {!input.required && <option value="">Not set</option>}
          {(validation.enum ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (input.type === 'multiselect') {
    const selected = Array.isArray(value) ? value : [];
    return (
      <label className="field">
        <span>{input.label}</span>
        <select
          multiple
          required={input.required}
          value={selected}
          onChange={(event) => onChange(Array.from(event.target.selectedOptions, (option) => option.value))}
        >
          {(validation.enum ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    );
  }

  return (
    <label className="field">
      <span>{input.label}</span>
      <input
        type={input.type === 'integer' ? 'number' : 'text'}
        required={input.required}
        value={typeof value === 'string' ? value : ''}
        min={input.type === 'integer' ? validation.min : undefined}
        max={input.type === 'integer' ? validation.max : undefined}
        minLength={input.type === 'string' ? validation.minLength : undefined}
        maxLength={input.type === 'string' ? validation.maxLength : undefined}
        pattern={input.type === 'string' && validation.pattern ? validation.pattern : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function App() {
  const [state, setState] = useState<ViewState>({ kind: 'loading' });
  const [selectedTaskKey, setSelectedTaskKey] = useState('');
  const [formValues, setFormValues] = useState<Record<string, FormValue>>({});
  const [run, setRun] = useState<RunView | null>(null);
  const [runError, setRunError] = useState('');
  const [starting, setStarting] = useState(false);

  const selectedTask = useMemo(() => {
    if (state.kind !== 'ready') {
      return undefined;
    }
    return state.tasks.find((task) => `${task.packId}/${task.commandId}` === selectedTaskKey) ?? state.tasks[0];
  }, [selectedTaskKey, state]);

  const acceptRuntime = useCallback((status: RuntimeStatus, tasks: Task[]) => {
    setState({ kind: 'ready', status, tasks });
    const firstTask = tasks[0];
    if (firstTask === undefined) {
      setSelectedTaskKey('');
      setFormValues({});
      return;
    }
    setSelectedTaskKey(`${firstTask.packId}/${firstTask.commandId}`);
    setFormValues(initialValues(firstTask));
  }, []);

  const retryStatus = () => {
    setState({ kind: 'loading' });
    void loadRuntime().then(
      ({ status, tasks }) => acceptRuntime(status, tasks),
      (error: unknown) => setState({ kind: 'error', ...errorMessage(error) }),
    );
  };

  useEffect(() => {
    const controller = new AbortController();
    void loadRuntime(controller.signal).then(
      ({ status, tasks }) => acceptRuntime(status, tasks),
      (error: unknown) => {
        if (!isAbort(error)) {
          setState({ kind: 'error', ...errorMessage(error) });
        }
      },
    );
    return () => controller.abort();
  }, [acceptRuntime]);

  const activeRunID = run?.snapshot.status === 'running' ? run.snapshot.runId : null;

  useEffect(() => {
    if (activeRunID === null) {
      return;
    }
    const close = subscribeRunEvents(
      activeRunID,
      (event) => setRun((current) => (current === null ? current : appendRunEvent(current, event))),
      (complete) => setRun((current) => (current === null ? current : completeRun(current, complete))),
      (error) =>
        setRun((current) =>
          current === null
            ? current
            : {
                ...current,
                streamMessage: error.message,
              },
        ),
    );
    return close;
  }, [activeRunID]);

  const startRun = async (event: FormEvent) => {
    event.preventDefault();
    if (state.kind !== 'ready' || selectedTask === undefined) {
      return;
    }
    setStarting(true);
    setRunError('');
    try {
      const snapshot = await createRun(state.status.csrfToken, {
        packId: selectedTask.packId,
        commandId: selectedTask.commandId,
        values: requestValues(selectedTask, formValues),
      });
      setRun({ snapshot, stdout: '', stderr: '', streamMessage: '', lastSequence: 0 });
    } catch (error) {
      setRunError(error instanceof Error ? error.message : 'CLIHarbor could not start the run.');
    } finally {
      setStarting(false);
    }
  };

  const cancelActiveRun = async () => {
    if (state.kind !== 'ready' || run === null || run.snapshot.status !== 'running') {
      return;
    }
    setRunError('');
    try {
      const snapshot = await cancelRun(state.status.csrfToken, run.snapshot.runId);
      setRun((current) => (current === null ? current : { ...current, snapshot }));
    } catch (error) {
      setRunError(error instanceof Error ? error.message : 'CLIHarbor could not cancel the run.');
    }
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <span className="eyebrow">LOCAL OPERATOR CONSOLE</span>
          <h1>CLIHarbor</h1>
        </div>
        <span className="local-badge">Local only</span>
      </header>

      <main>
        <section className="hero" aria-labelledby="runtime-heading">
          <div>
            <p className="hero-kicker">Secure local runtime</p>
            <h2 id="runtime-heading">Run curated CLI tasks without handing execution authority to the browser.</h2>
            <p>
              CLIHarbor is listening only on the loopback interface. Task metadata is server-provided and execution stays
              bound to trusted packs and discovered tools.
            </p>
          </div>
        </section>

        {state.kind === 'loading' && (
          <section className="panel" role="status" aria-live="polite">
            <h2>Checking runtime</h2>
            <p>Verifying the authenticated local browser session and available safe tasks…</p>
          </section>
        )}

        {state.kind === 'error' && (
          <section className="panel error-panel" role="alert">
            <p className="status-label">Connection state</p>
            <h2>{state.sessionUnavailable ? 'Browser session unavailable' : 'Runtime status unavailable'}</h2>
            <p>{state.message}</p>
            {!state.sessionUnavailable && (
              <button type="button" onClick={retryStatus}>
                Retry status check
              </button>
            )}
          </section>
        )}

        {state.kind === 'ready' && (
          <>
            <section className="status-grid" aria-label="CLIHarbor status">
              <article className="panel">
                <p className="status-label">Application</p>
                <h2>{state.status.name}</h2>
                <dl>
                  <div>
                    <dt>Version</dt>
                    <dd>{state.status.version}</dd>
                  </div>
                </dl>
              </article>
              <article className="panel">
                <p className="status-label">Local runtime</p>
                <h2>Running</h2>
                <p>Bound to this computer only.</p>
              </article>
              <article className="panel">
                <p className="status-label">Safe tasks</p>
                <h2>{state.tasks.length}</h2>
                <p>Only read-only, non-secret tasks with a ready tool are exposed.</p>
              </article>
            </section>

            <section className="workspace-grid">
              <article className="panel">
                <p className="status-label">Task</p>
                <h2>Run a safe task</h2>
                {state.tasks.length === 0 ? (
                  <p>No runnable tasks are currently available. Load a trusted pack and ensure its tool is discovered.</p>
                ) : (
                  <form onSubmit={startRun}>
                    <label className="field">
                      <span>Available task</span>
                      <select
                        value={selectedTaskKey}
                        onChange={(event) => {
                          const key = event.target.value;
                          setSelectedTaskKey(key);
                          const task = state.tasks.find((candidate) => `${candidate.packId}/${candidate.commandId}` === key);
                          setFormValues(initialValues(task));
                        }}
                        disabled={run?.snapshot.status === 'running'}
                      >
                        {state.tasks.map((task) => {
                          const key = `${task.packId}/${task.commandId}`;
                          return (
                            <option key={key} value={key}>
                              {task.packName} — {task.name}
                            </option>
                          );
                        })}
                      </select>
                    </label>

                    {selectedTask !== undefined && (
                      <>
                        <div className="task-context">
                          <strong>{selectedTask.name}</strong>
                          {selectedTask.description && <p>{selectedTask.description}</p>}
                          <p>
                            Tool: {selectedTask.toolId}
                            {selectedTask.toolVersion ? ` ${selectedTask.toolVersion}` : ''}
                          </p>
                        </div>
                        <div className="form-stack">
                          {selectedTask.inputs.map((input) => (
                            <InputControl
                              key={input.id}
                              input={input}
                              value={formValues[input.id]}
                              onChange={(value) => setFormValues((current) => ({ ...current, [input.id]: value }))}
                            />
                          ))}
                        </div>
                        <button type="submit" disabled={starting || run?.snapshot.status === 'running'}>
                          {starting ? 'Starting…' : 'Run task'}
                        </button>
                      </>
                    )}
                  </form>
                )}
              </article>

              <article className="panel run-panel" aria-live="polite">
                <p className="status-label">Run</p>
                <h2>{run === null ? 'No active run' : run.snapshot.status}</h2>
                {run === null ? (
                  <p>Start a safe task to stream its output here.</p>
                ) : (
                  <>
                    <dl className="run-meta">
                      <div>
                        <dt>Run ID</dt>
                        <dd>{run.snapshot.runId}</dd>
                      </div>
                      <div>
                        <dt>Exit code</dt>
                        <dd>{run.snapshot.exitCode ?? '—'}</dd>
                      </div>
                    </dl>
                    {run.snapshot.status === 'running' && (
                      <button type="button" className="secondary-button" onClick={() => void cancelActiveRun()}>
                        Cancel run
                      </button>
                    )}
                    {run.streamMessage && <p className="stream-message">{run.streamMessage}</p>}
                    <div className="output-grid">
                      <section>
                        <h3>stdout</h3>
                        <pre>{run.stdout || 'No stdout yet.'}</pre>
                      </section>
                      <section>
                        <h3>stderr</h3>
                        <pre>{run.stderr || 'No stderr yet.'}</pre>
                      </section>
                    </div>
                  </>
                )}
                {runError && <p className="run-error">{runError}</p>}
              </article>
            </section>
          </>
        )}
      </main>

      <footer>
        <p>No cloud backend. No telemetry by default. No remote runtime assets.</p>
      </footer>
    </div>
  );
}

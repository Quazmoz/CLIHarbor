import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { normalizeError, invalidInputError, type AppErrorDetail } from './api/errors';
import { fetchRuntimeStatus, type RuntimeStatus } from './api/status';
import { fetchTasks, type Task, type TaskInput } from './api/tasks';
import { fetchTools, type ToolDiagnostic } from './api/tools';
import {
  cancelRun,
  createRun,
  decodeBase64Text,
  fetchRun,
  subscribeRunEvents,
  type RunComplete,
  type RunEvent,
  type RunSnapshot,
  type StructuredErrorCode,
} from './api/runs';

type ViewState =
  | { kind: 'loading' }
  | { kind: 'ready'; status: RuntimeStatus; tasks: Task[]; tools: ToolDiagnostic[] }
  | { kind: 'error'; failure: AppErrorDetail };

type FormValue = string | boolean | string[];
type StreamState = 'connecting' | 'connected' | 'stopped' | 'idle';

interface RunView {
  snapshot: RunSnapshot;
  stdout: string;
  stderr: string;
  streamState: StreamState;
  streamFailure?: AppErrorDetail;
  retained: boolean;
  lastSequence: number;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

async function loadRuntime(
  signal?: AbortSignal,
): Promise<{ status: RuntimeStatus; tasks: Task[]; tools: ToolDiagnostic[] }> {
  const status = await fetchRuntimeStatus(signal);
  const [tasks, tools] = await Promise.all([fetchTasks(signal), fetchTools(signal)]);
  return { status, tasks, tools };
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
    if (input.type === 'integer') {
      const integer = Number(text);
      if (!Number.isSafeInteger(integer)) {
        throw invalidInputError(`values.${input.id}`);
      }
      values[input.id] = integer;
    } else {
      values[input.id] = text;
    }
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
    lastSequence: event.sequence,
  };
}

function reconcileRunSnapshot(current: RunView, snapshot: RunSnapshot): RunView {
  if (snapshot.runId !== current.snapshot.runId) {
    return current;
  }

  let reconciled: RunView = {
    ...current,
    snapshot,
    retained: true,
  };
  for (const event of snapshot.events ?? []) {
    reconciled = appendRunEvent(reconciled, {
      ...event,
      runId: snapshot.runId,
    });
  }

  const running = snapshot.status === 'running';
  return {
    ...reconciled,
    snapshot,
    streamState: running ? current.streamState : 'idle',
    streamFailure: running ? current.streamFailure : undefined,
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
      structured: complete.structured,
      failure: complete.failure,
    },
    streamState: 'idle',
    streamFailure: undefined,
    lastSequence: Math.max(current.lastSequence, complete.sequence),
  };
}

function taskInputDOMID(inputID: string): string {
  return `task-input-${inputID}`;
}

function fieldFailureFor(input: TaskInput, failure: AppErrorDetail | null): AppErrorDetail | undefined {
  return failure?.field === `values.${input.id}` ? failure : undefined;
}

function isTaskFieldFailure(task: Task | undefined, failure: AppErrorDetail | null): boolean {
  if (task === undefined || failure?.field === undefined) {
    return false;
  }
  return task.inputs.some((input) => failure.field === `values.${input.id}`);
}

function FailureNotice({ title, failure }: { title: string; failure: AppErrorDetail }) {
  return (
    <div className="failure-notice" role="alert">
      <strong>{title}</strong>
      <p>{failure.message}</p>
      {failure.remediation && <p className="remediation">{failure.remediation}</p>}
      <p className="error-code">
        Error code: <code>{failure.code}</code>
      </p>
    </div>
  );
}

function FieldFailure({ id, failure }: { id: string; failure: AppErrorDetail }) {
  return (
    <p id={id} className="field-error" role="alert">
      {failure.message} {failure.remediation}
    </p>
  );
}

function InputControl({
  input,
  value,
  onChange,
  error,
}: {
  input: TaskInput;
  value: FormValue | undefined;
  onChange: (value: FormValue) => void;
  error?: AppErrorDetail;
}) {
  const validation = input.validation ?? {};
  const domID = taskInputDOMID(input.id);
  const errorID = `${domID}-error`;
  const describedBy = error === undefined ? undefined : errorID;

  if (input.type === 'boolean') {
    return (
      <div className="field-group">
        <label className="checkbox-row">
          <input
            id={domID}
            type="checkbox"
            checked={value === true}
            aria-invalid={error === undefined ? undefined : true}
            aria-describedby={describedBy}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span>{input.label}</span>
        </label>
        {error && <FieldFailure id={errorID} failure={error} />}
      </div>
    );
  }

  if (input.type === 'enum') {
    return (
      <div className="field-group">
        <label className="field">
          <span>{input.label}</span>
          <select
            id={domID}
            required={input.required}
            value={typeof value === 'string' ? value : ''}
            aria-invalid={error === undefined ? undefined : true}
            aria-describedby={describedBy}
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
        {error && <FieldFailure id={errorID} failure={error} />}
      </div>
    );
  }

  if (input.type === 'multiselect') {
    const selected = Array.isArray(value) ? value : [];
    return (
      <div className="field-group">
        <label className="field">
          <span>{input.label}</span>
          <select
            id={domID}
            multiple
            required={input.required}
            value={selected}
            aria-invalid={error === undefined ? undefined : true}
            aria-describedby={describedBy}
            onChange={(event) => onChange(Array.from(event.target.selectedOptions, (option) => option.value))}
          >
            {(validation.enum ?? []).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        {error && <FieldFailure id={errorID} failure={error} />}
      </div>
    );
  }

  return (
    <div className="field-group">
      <label className="field">
        <span>{input.label}</span>
        <input
          id={domID}
          type={input.type === 'integer' ? 'number' : 'text'}
          required={input.required}
          value={typeof value === 'string' ? value : ''}
          step={input.type === 'integer' ? 1 : undefined}
          min={input.type === 'integer' ? validation.min : undefined}
          max={input.type === 'integer' ? validation.max : undefined}
          minLength={input.type === 'string' ? validation.minLength : undefined}
          maxLength={input.type === 'string' ? validation.maxLength : undefined}
          pattern={input.type === 'string' ? validation.pattern : undefined}
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      {error && <FieldFailure id={errorID} failure={error} />}
    </div>
  );
}

function structuredFailureMessage(code: StructuredErrorCode | undefined): string {
  switch (code) {
    case 'output_too_large':
      return 'Structured rendering is unavailable because the captured output exceeded the parser safety limit.';
    case 'run_cancelled':
      return 'Structured rendering is unavailable because the run was cancelled.';
    case 'run_timed_out':
      return 'Structured rendering is unavailable because the run timed out.';
    case 'nonzero_exit':
      return 'Structured rendering is unavailable because the command exited with a non-zero status.';
    case 'execution_failed':
      return 'Structured rendering is unavailable because local execution failed.';
    case 'sensitive_output':
      return 'Structured rendering is unavailable because the output is classified as sensitive.';
    case 'unknown':
      return 'Structured rendering returned an unrecognized parser status.';
    default:
      return 'Structured rendering could not validate this output.';
  }
}

function runStatusDescription(run: RunView, cancelRequested: boolean): string {
  if (!run.retained) {
    return 'The retained run record is no longer available on this local runtime.';
  }
  switch (run.snapshot.status) {
    case 'running':
      return cancelRequested ? 'Cancellation requested. Waiting for the local process boundary to finish.' : 'The task is running locally.';
    case 'exited':
      return run.snapshot.exitCode === 0
        ? 'The task completed.'
        : `The task exited with code ${run.snapshot.exitCode ?? 'unknown'}.`;
    case 'cancelled':
      return 'The run was cancelled.';
    case 'timed-out':
      return 'The run reached CLIHarbor\'s execution time limit and was stopped.';
    case 'failed':
      return 'CLIHarbor could not complete the local process lifecycle.';
  }
}

function streamStateText(state: StreamState): string {
  switch (state) {
    case 'connecting':
      return 'Live updates: connecting.';
    case 'connected':
      return 'Live updates: connected.';
    case 'stopped':
      return 'Live updates: stopped.';
    case 'idle':
      return 'Live updates: complete.';
  }
}

export function App() {
  const [state, setState] = useState<ViewState>({ kind: 'loading' });
  const [selectedTaskKey, setSelectedTaskKey] = useState('');
  const [formValues, setFormValues] = useState<Record<string, FormValue>>({});
  const [run, setRun] = useState<RunView | null>(null);
  const [taskFailure, setTaskFailure] = useState<AppErrorDetail | null>(null);
  const [runActionFailure, setRunActionFailure] = useState<AppErrorDetail | null>(null);
  const [starting, setStarting] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [streamAttempt, setStreamAttempt] = useState(0);
  const runtimeErrorRef = useRef<HTMLElement>(null);
  const taskErrorRef = useRef<HTMLDivElement>(null);

  const readyToolCount = state.kind === 'ready' ? state.tools.filter((tool) => tool.status === 'ready').length : 0;

  const selectedTask = useMemo(() => {
    if (state.kind !== 'ready') {
      return undefined;
    }
    return state.tasks.find((task) => `${task.packId}/${task.commandId}` === selectedTaskKey) ?? state.tasks[0];
  }, [selectedTaskKey, state]);

  const acceptRuntime = useCallback((status: RuntimeStatus, tasks: Task[], tools: ToolDiagnostic[]) => {
    setState({ kind: 'ready', status, tasks, tools });
    const firstTask = tasks[0];
    if (firstTask === undefined) {
      setSelectedTaskKey('');
      setFormValues({});
      return;
    }
    setSelectedTaskKey(`${firstTask.packId}/${firstTask.commandId}`);
    setFormValues(initialValues(firstTask));
  }, []);

  const loadFailure = useCallback((error: unknown) => {
    setState({ kind: 'error', failure: normalizeError(error).detail });
  }, []);

  const retryStatus = () => {
    setState({ kind: 'loading' });
    void loadRuntime().then(
      ({ status, tasks, tools }) => acceptRuntime(status, tasks, tools),
      (error: unknown) => loadFailure(error),
    );
  };

  useEffect(() => {
    const controller = new AbortController();
    void loadRuntime(controller.signal).then(
      ({ status, tasks, tools }) => acceptRuntime(status, tasks, tools),
      (error: unknown) => {
        if (!isAbort(error)) {
          loadFailure(error);
        }
      },
    );
    return () => controller.abort();
  }, [acceptRuntime, loadFailure]);

  useEffect(() => {
    if (state.kind === 'error') {
      runtimeErrorRef.current?.focus();
    }
  }, [state]);

  useEffect(() => {
    if (taskFailure === null) {
      return;
    }
    if (taskFailure.field?.startsWith('values.') && selectedTask !== undefined) {
      const inputID = taskFailure.field.slice('values.'.length);
      if (selectedTask.inputs.some((input) => input.id === inputID)) {
        document.getElementById(taskInputDOMID(inputID))?.focus();
        return;
      }
    }
    taskErrorRef.current?.focus();
  }, [taskFailure, selectedTask]);

  const activeRunID =
    run !== null && run.retained && run.snapshot.status === 'running' ? run.snapshot.runId : null;

  useEffect(() => {
    if (activeRunID === null) {
      return;
    }
    const close = subscribeRunEvents(
      activeRunID,
      (event) => setRun((current) => (current === null ? current : appendRunEvent(current, event))),
      (complete) => {
        setCancelRequested(false);
        setRun((current) => (current === null ? current : completeRun(current, complete)));
      },
      (error) => {
        const failure = error.detail;
        setRun((current) =>
          current === null || current.snapshot.runId !== activeRunID
            ? current
            : { ...current, streamFailure: failure, streamState: 'stopped' },
        );
        void fetchRun(activeRunID).then(
          (snapshot) => {
            if (snapshot.status !== 'running') {
              setCancelRequested(false);
            }
            setRun((current) => (current === null ? current : reconcileRunSnapshot(current, snapshot)));
          },
          (fetchError: unknown) => {
            const reconcileFailure = normalizeError(fetchError).detail;
            setRun((current) => {
              if (current === null || current.snapshot.runId !== activeRunID) {
                return current;
              }
              if (reconcileFailure.code === 'run_not_found') {
                return {
                  ...current,
                  retained: false,
                  streamState: 'stopped',
                  streamFailure: reconcileFailure,
                };
              }
              return {
                ...current,
                streamState: 'stopped',
                streamFailure: reconcileFailure,
              };
            });
          },
        );
      },
      () =>
        setRun((current) =>
          current === null || current.snapshot.runId !== activeRunID
            ? current
            : { ...current, streamState: 'connected', streamFailure: undefined },
        ),
    );
    return close;
  }, [activeRunID, streamAttempt]);

  const startRun = async (event: FormEvent) => {
    event.preventDefault();
    if (state.kind !== 'ready' || selectedTask === undefined) {
      return;
    }
    setStarting(true);
    setTaskFailure(null);
    setRunActionFailure(null);
    try {
      const snapshot = await createRun(state.status.csrfToken, {
        packId: selectedTask.packId,
        commandId: selectedTask.commandId,
        values: requestValues(selectedTask, formValues),
      });
      setRun({
        snapshot,
        stdout: '',
        stderr: '',
        streamState: snapshot.status === 'running' ? 'connecting' : 'idle',
        retained: true,
        lastSequence: 0,
      });
      setCancelRequested(false);
      setStreamAttempt(0);
    } catch (error) {
      setTaskFailure(normalizeError(error).detail);
    } finally {
      setStarting(false);
    }
  };

  const retryLiveStream = () => {
    if (run === null || !run.retained || run.snapshot.status !== 'running') {
      return;
    }
    setRun((current) =>
      current === null
        ? current
        : {
            ...current,
            streamFailure: undefined,
            streamState: 'connecting',
          },
    );
    setStreamAttempt((current) => current + 1);
  };

  const cancelActiveRun = async () => {
    if (
      state.kind !== 'ready' ||
      run === null ||
      !run.retained ||
      run.snapshot.status !== 'running' ||
      cancelRequested
    ) {
      return;
    }
    setRunActionFailure(null);
    setCancelRequested(true);
    try {
      const snapshot = await cancelRun(state.status.csrfToken, run.snapshot.runId);
      setRun((current) => (current === null ? current : { ...current, snapshot }));
      if (snapshot.status !== 'running') {
        setCancelRequested(false);
      }
    } catch (error) {
      const failure = normalizeError(error).detail;
      setRunActionFailure(failure);
      setCancelRequested(false);
      if (failure.code === 'run_not_found') {
        setRun((current) => (current === null ? current : { ...current, retained: false, streamState: 'stopped' }));
      }
    }
  };

  const taskHasFieldFailure = isTaskFieldFailure(selectedTask, taskFailure);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <span className="eyebrow">LOCAL OPERATOR CONSOLE</span>
          <h1>CLIHarbor</h1>
        </div>
        <span className="local-badge">Local only</span>
      </header>

      <main aria-busy={state.kind === 'loading'}>
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
          <section className="panel" role="status" aria-live="polite" aria-busy="true">
            <h2>Checking runtime</h2>
            <p>Verifying the authenticated local browser session and available safe tasks…</p>
          </section>
        )}

        {state.kind === 'error' && (
          <section ref={runtimeErrorRef} className="panel error-panel" role="alert" tabIndex={-1}>
            <p className="status-label">Connection state</p>
            <h2>{state.failure.code === 'session_unavailable' ? 'Browser session unavailable' : 'Runtime status unavailable'}</h2>
            <p>{state.failure.message}</p>
            {state.failure.remediation && <p>{state.failure.remediation}</p>}
            <p className="error-code">
              Error code: <code>{state.failure.code}</code>
            </p>
            {state.failure.retryable && (
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
                <p className="status-label">Tools ready</p>
                <h2>
                  {readyToolCount}/{state.tools.length}
                </h2>
                <p>Discovery state is sanitized before it reaches the browser.</p>
              </article>
              <article className="panel">
                <p className="status-label">Safe tasks</p>
                <h2>{state.tasks.length}</h2>
                <p>Only read-only, non-secret tasks with a ready tool are exposed.</p>
              </article>
            </section>

            <section className="panel tool-diagnostics" aria-labelledby="tool-diagnostics-heading">
              <p className="status-label">Tool diagnostics</p>
              <h2 id="tool-diagnostics-heading">Configured CLI tools</h2>
              {state.tools.length === 0 ? (
                <p>No tools are configured. Load an explicitly trusted pack to inspect tool availability.</p>
              ) : (
                <ul className="tool-list">
                  {state.tools.map((tool) => (
                    <li key={`${tool.packId}/${tool.toolId}`}>
                      <div className="tool-summary">
                        <strong>{tool.packName} — {tool.toolId}</strong>
                        <span className="tool-status">{tool.status}</span>
                      </div>
                      <p>
                        Pack {tool.packVersion}
                        {tool.version ? ` · Detected ${tool.version}` : ''}
                        {tool.versionConstraint ? ` · Required ${tool.versionConstraint}` : ''}
                      </p>
                      {tool.message && <p>{tool.message}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="workspace-grid">
              <article className="panel" aria-labelledby="task-heading">
                <p className="status-label">Task</p>
                <h2 id="task-heading">Run a safe task</h2>
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
                          setTaskFailure(null);
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
                              error={fieldFailureFor(input, taskFailure)}
                              onChange={(value) => {
                                setFormValues((current) => ({ ...current, [input.id]: value }));
                                if (taskFailure?.field === `values.${input.id}`) {
                                  setTaskFailure(null);
                                }
                              }}
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
                {taskFailure && !taskHasFieldFailure && (
                  <div ref={taskErrorRef} tabIndex={-1}>
                    <FailureNotice title="Task could not start" failure={taskFailure} />
                  </div>
                )}
              </article>

              <article className="panel run-panel" aria-labelledby="run-heading">
                <p className="status-label">Run</p>
                <div className="run-state" role="status" aria-live="polite" aria-atomic="true">
                  <h2 id="run-heading">{run === null ? 'No active run' : run.retained ? run.snapshot.status : 'run no longer retained'}</h2>
                  <p>{run === null ? 'Start a safe task to stream its output here.' : runStatusDescription(run, cancelRequested)}</p>
                </div>
                {run !== null && (
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
                    {run.retained && run.snapshot.status === 'running' && (
                      <>
                        <p className="stream-state" role="status" aria-live="polite" aria-atomic="true">
                          {streamStateText(run.streamState)}
                        </p>
                        <div className="run-actions">
                          <button
                            type="button"
                            className="secondary-button"
                            disabled={cancelRequested}
                            onClick={() => void cancelActiveRun()}
                          >
                            {cancelRequested ? 'Cancellation requested' : 'Cancel run'}
                          </button>
                          {run.streamState === 'stopped' && (
                            <button type="button" className="secondary-button" onClick={retryLiveStream}>
                              Retry live stream
                            </button>
                          )}
                        </div>
                      </>
                    )}
                    {run.streamFailure && (
                      <FailureNotice title={run.retained ? 'Live updates interrupted' : 'Run unavailable'} failure={run.streamFailure} />
                    )}
                    {run.snapshot.failure && <FailureNotice title="Run failure" failure={run.snapshot.failure} />}
                    {runActionFailure && <FailureNotice title="Run action failed" failure={runActionFailure} />}
                    {run.snapshot.structured && (
                      <section className="structured-result" aria-labelledby="structured-result-heading">
                        <h3 id="structured-result-heading">Structured result</h3>
                        {run.snapshot.structured.status === 'available' ? (
                          <dl className="structured-grid">
                            {(run.snapshot.structured.fields ?? []).map((field) => (
                              <div key={field.key} className="structured-card">
                                <dt>{field.label}</dt>
                                <dd>{field.present ? field.value : 'Not provided'}</dd>
                              </div>
                            ))}
                          </dl>
                        ) : (
                          <p className="parser-warning">
                            {structuredFailureMessage(run.snapshot.structured.error)}
                            {run.snapshot.structured.error && (
                              <>
                                {' '}Parser code: <code>{run.snapshot.structured.error}</code>.
                              </>
                            )}{' '}
                            Raw stdout and stderr remain available below.
                          </p>
                        )}
                      </section>
                    )}
                    <div className="output-grid">
                      <section aria-labelledby="stdout-heading">
                        <h3 id="stdout-heading">stdout</h3>
                        <pre tabIndex={0}>{run.stdout || 'No stdout yet.'}</pre>
                      </section>
                      <section aria-labelledby="stderr-heading">
                        <h3 id="stderr-heading">stderr</h3>
                        <pre tabIndex={0}>{run.stderr || 'No stderr yet.'}</pre>
                      </section>
                    </div>
                  </>
                )}
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

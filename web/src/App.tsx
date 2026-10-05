import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { normalizeError, invalidInputError, type AppErrorDetail } from './api/errors';
import { fetchRuntimeStatus, type RuntimeStatus } from './api/status';
import { fetchTasks, type Task, type TaskInput } from './api/tasks';
import { fetchTools, installTool, type ToolDiagnostic } from './api/tools';
import {
  cancelRun,
  createRun,
  decodeRunOutput,
  fetchRun,
  previewRun,
  subscribeRunEvents,
  type CreateRunRequest,
  type RunComplete,
  type RunEvent,
  type RunPreview,
  type RunSnapshot,
  type StructuredErrorCode,
} from './api/runs';
import { AuthenticationPage } from './AuthenticationPage';
import { RunsPage, formatDuration, formatTimestamp } from './RunsPage';
import { SecretAuditPage } from './SecretAuditPage';
import { OverviewPage } from './OverviewPage';
import { TaskDiscovery } from './TaskDiscovery';
import { StructuredResultView } from './StructuredResultView';
import { describeToolReadiness, inputGuidance, runOutcomeHeading, runOutcomeTone } from './operatorLanguage';
import {
  loadTaskPreferences,
  recordRecentTask,
  reconcileTaskPreferences,
  saveTaskPreferences,
  toggleFavoriteTask,
  type TaskPreferences,
} from './taskPreferences';

type ViewState =
  | { kind: 'loading' }
  | { kind: 'ready'; status: RuntimeStatus; tasks: Task[]; tools: ToolDiagnostic[] }
  | { kind: 'error'; failure: AppErrorDetail };

type FormValue = string | boolean | string[];
type StreamState = 'connecting' | 'connected' | 'stopped' | 'idle';

interface RetryRun {
  taskKey: string;
  formValues: Record<string, FormValue>;
  request: CreateRunRequest;
}

interface RunView {
  snapshot: RunSnapshot;
  streamState: StreamState;
  streamFailure?: AppErrorDetail;
  retained: boolean;
  lastSequence: number;
  retry: RetryRun;
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
    if (input.required && (text.length === 0 || (input.type === 'integer' && text.trim().length === 0))) {
      throw invalidInputError(`values.${input.id}`);
    }
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

function cloneFormValues(values: Record<string, FormValue>): Record<string, FormValue> {
  const cloned: Record<string, FormValue> = {};
  for (const [key, value] of Object.entries(values)) {
    cloned[key] = Array.isArray(value) ? [...value] : value;
  }
  return cloned;
}

function cloneRunRequest(request: CreateRunRequest): CreateRunRequest {
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(request.values)) {
    values[key] = Array.isArray(value) ? [...value] : value;
  }
  return { packId: request.packId, commandId: request.commandId, values };
}

function formatInvocationToken(token: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/u.test(token) ? token : JSON.stringify(token);
}

function formatInvocation(preview: RunPreview): string {
  return [preview.executableName, ...preview.args].map(formatInvocationToken).join(' ');
}

function appendRunEvent(current: RunView, event: RunEvent): RunView {
  if (event.runId !== current.snapshot.runId || event.sequence <= current.lastSequence) {
    return current;
  }
  return {
    ...current,
    snapshot: {
      ...current.snapshot,
      // The create response predates the start event; take the start time from the stream.
      startedAt: current.snapshot.startedAt ?? event.timestamp,
      events: [...(current.snapshot.events ?? []), event],
    },
    lastSequence: event.sequence,
  };
}

function reconcileRunSnapshot(current: RunView, snapshot: RunSnapshot): RunView {
  if (snapshot.runId !== current.snapshot.runId || !current.retained) {
    return current;
  }
  if (current.snapshot.status !== 'running' && snapshot.status !== current.snapshot.status) {
    return current;
  }

  const lastSequence = snapshot.events?.at(-1)?.sequence ?? 0;
  if (snapshot.status === 'running' && lastSequence < current.lastSequence) return current;

  const running = snapshot.status === 'running';
  return {
    ...current,
    snapshot: { ...snapshot, events: snapshot.events ?? current.snapshot.events },
    lastSequence: Math.max(current.lastSequence, lastSequence),
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
      // run-complete carries no timestamp; the backend shares this machine's clock.
      endedAt: current.snapshot.endedAt ?? new Date().toISOString(),
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

// Copy is explicit and session-only; there is deliberately no download because
// packs declare raw output as not persisted (persistRawOutput: false).
function OutputStream({ name, text, live }: { name: 'stdout' | 'stderr'; text: string; live: boolean }) {
  // The notice belongs to the text it copied, so new streamed output clears it.
  const [notice, setNotice] = useState<{ text: string; message: string } | null>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const followRef = useRef(true);
  // Keep the newest streamed lines visible unless the operator scrolled up to read.
  useLayoutEffect(() => {
    const pre = preRef.current;
    if (pre !== null && followRef.current) pre.scrollTop = pre.scrollHeight;
  }, [text]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice({ text, message: `Copied ${name}.` });
    } catch {
      setNotice({ text, message: `Could not copy ${name}. Clipboard access is unavailable in this browser.` });
    }
  };
  return (
    <section aria-labelledby={name + '-heading'}>
      <div className="output-heading">
        <h3 id={name + '-heading'}>{name}</h3>
        <button type="button" className="structured-copy-button" disabled={text === ''} onClick={() => void copy()}>
          Copy {name}
        </button>
      </div>
      <pre
        ref={preRef}
        tabIndex={0}
        onScroll={(event) => {
          const pre = event.currentTarget;
          followRef.current = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
        }}
      >
        {text || (live ? `No ${name} yet.` : `No ${name}.`)}
      </pre>
      {notice?.text === text && (
        <p className="structured-copy-status" role="status">
          {notice.message}
        </p>
      )}
    </section>
  );
}

function RunTiming({ startedAt, endedAt }: { startedAt: string; endedAt?: string }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (endedAt !== undefined) return undefined;
    const timer = window.setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => window.clearInterval(timer);
  }, [endedAt]);
  return (
    <p className="run-timing">
      Started {formatTimestamp(startedAt)} · {endedAt === undefined ? 'running for' : 'took'} {formatDuration(startedAt, endedAt)}
    </p>
  );
}

function FailureNotice({ title, failure }: { title: string; failure: AppErrorDetail }) {
  return (
    <div className="failure-notice" role="alert">
      <strong>{title}</strong>
      <p>{failure.message}</p>
      {failure.remediation && <p className="remediation">{failure.remediation}</p>}
      <details className="technical-details">
        <summary>Technical details</summary>
        <p className="error-code">
          Error code: <code>{failure.code}</code> · Category: <code>{failure.category}</code>
        </p>
      </details>
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

function FieldLabel({ input }: { input: TaskInput }) {
  return (
    <span className="field-label-text">
      <span>{input.label}</span>
      <span className="field-requirement" aria-hidden="true">
        {input.required ? 'Required' : 'Optional'}
      </span>
    </span>
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
  const helpID = `${domID}-help`;
  const guidance = inputGuidance(input);
  const describedBy = [guidance === undefined ? undefined : helpID, error === undefined ? undefined : errorID]
    .filter((id): id is string => id !== undefined)
    .join(' ') || undefined;

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
          <FieldLabel input={input} />
        </label>
        {guidance && <p id={helpID} className="field-help">{guidance}</p>}
        {error && <FieldFailure id={errorID} failure={error} />}
      </div>
    );
  }

  if (input.type === 'enum') {
    return (
      <div className="field-group">
        <label className="field">
          <FieldLabel input={input} />
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
        {guidance && <p id={helpID} className="field-help">{guidance}</p>}
        {error && <FieldFailure id={errorID} failure={error} />}
      </div>
    );
  }

  if (input.type === 'multiselect') {
    const selected = Array.isArray(value) ? value : [];
    return (
      <div className="field-group">
        <label className="field">
          <FieldLabel input={input} />
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
        {guidance && <p id={helpID} className="field-help">{guidance}</p>}
        {error && <FieldFailure id={errorID} failure={error} />}
      </div>
    );
  }

  return (
    <div className="field-group">
      <label className="field">
        <FieldLabel input={input} />
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
      {guidance && <p id={helpID} className="field-help">{guidance}</p>}
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
        ? 'The task completed successfully.'
        : 'The task ended unsuccessfully. Review the result and output below, adjust inputs if appropriate, then retry when safe.';
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

type AppRoute = 'overview' | 'authentication' | 'tasks' | 'runs' | 'secret-audit' | 'diagnostics';

const routePaths: Record<AppRoute, string> = {
  overview: '/',
  authentication: '/authentication',
  tasks: '/tasks',
  runs: '/runs',
  'secret-audit': '/secret-audit',
  diagnostics: '/diagnostics',
};

const conjurPackID = 'cyberark-conjur-v9';

const navigationItems: Array<{ route: AppRoute; label: string }> = [
  { route: 'overview', label: 'Overview' },
  { route: 'authentication', label: 'Authentication' },
  { route: 'tasks', label: 'Tasks' },
  { route: 'runs', label: 'Runs' },
  { route: 'secret-audit', label: 'Secret audit' },
  { route: 'diagnostics', label: 'Diagnostics' },
];

function routeFromPath(pathname: string): AppRoute {
  switch (pathname) {
    case '/authentication':
      return 'authentication';
    case '/tasks':
      return 'tasks';
    case '/runs':
      return 'runs';
    case '/secret-audit':
      return 'secret-audit';
    case '/diagnostics':
      return 'diagnostics';
    default:
      return 'overview';
  }
}

export function App() {
  const [state, setState] = useState<ViewState>({ kind: 'loading' });
  const [runtimeAttempt, setRuntimeAttempt] = useState(0);
  const [route, setRoute] = useState<AppRoute>(() => routeFromPath(window.location.pathname));
  const [selectedTaskKey, setSelectedTaskKey] = useState('');
  const [taskChosen, setTaskChosen] = useState(false);
  const [taskPreferences, setTaskPreferences] = useState<TaskPreferences>(() => loadTaskPreferences());
  const [formValues, setFormValues] = useState<Record<string, FormValue>>({});
  const [run, setRun] = useState<RunView | null>(null);
  const [taskFailure, setTaskFailure] = useState<AppErrorDetail | null>(null);
  const [runActionFailure, setRunActionFailure] = useState<AppErrorDetail | null>(null);
  const [commandPreview, setCommandPreview] = useState<RunPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [streamAttempt, setStreamAttempt] = useState(0);
  const [installingToolKey, setInstallingToolKey] = useState<string | null>(null);
  const [toolInstallNotice, setToolInstallNotice] = useState<{ key: string; message: string; failure?: AppErrorDetail } | null>(null);
  const [toolInstallRoots, setToolInstallRoots] = useState<Record<string, string>>({});
  const runtimeErrorRef = useRef<HTMLElement>(null);
  const taskErrorRef = useRef<HTMLDivElement>(null);
  const resultHeadingRef = useRef<HTMLHeadingElement>(null);
  const configurationHeadingRef = useRef<HTMLHeadingElement>(null);
  const focusConfigurationRef = useRef(false);
  const mainRef = useRef<HTMLElement>(null);
  const taskFormRef = useRef<HTMLFormElement>(null);
  const previousRouteRef = useRef(route);
  const startingRef = useRef(false);
  const displayedRunIDRef = useRef<string | null>(null);
  const previewRequestRef = useRef(0);

  const updateTaskPreferences = useCallback((update: (current: TaskPreferences) => TaskPreferences) => {
    setTaskPreferences((current) => {
      const next = update(current);
      saveTaskPreferences(next);
      return next;
    });
  }, []);

  const selectTaskByKey = useCallback((key: string, tasks: Task[]) => {
    const task = tasks.find((candidate) => candidate.packId + '/' + candidate.commandId === key);
    if (task === undefined) {
      return;
    }
    setSelectedTaskKey(key);
    setTaskChosen(true);
    setFormValues(initialValues(task));
    previewRequestRef.current += 1;
    setCommandPreview(null);
    setPreviewing(false);
    setTaskFailure(null);
  }, []);

  const readyToolCount = state.kind === 'ready' ? state.tools.filter((tool) => tool.status === 'ready').length : 0;

  const selectedTask = useMemo(() => {
    if (state.kind !== 'ready') {
      return undefined;
    }
    return state.tasks.find((task) => `${task.packId}/${task.commandId}` === selectedTaskKey) ?? state.tasks[0];
  }, [selectedTaskKey, state]);

  const acceptRuntime = useCallback((status: RuntimeStatus, tasks: Task[], tools: ToolDiagnostic[]) => {
    setState({ kind: 'ready', status, tasks, tools });
    previewRequestRef.current += 1;
    setCommandPreview(null);
    setPreviewing(false);
    const reconciledPreferences = reconcileTaskPreferences(loadTaskPreferences(), tasks);
    setTaskPreferences(reconciledPreferences);
    saveTaskPreferences(reconciledPreferences);
    const firstTask = tasks[0];
    if (firstTask === undefined) {
      setSelectedTaskKey('');
      setFormValues({});
      return;
    }
    setSelectedTaskKey(`${firstTask.packId}/${firstTask.commandId}`);
    setFormValues(initialValues(firstTask));
  }, []);

  const refreshTools = useCallback(() => {
    // Best effort: on failure the current snapshot stays and a reload recovers.
    void fetchTools().then(
      (tools) => setState((current) => (current.kind === 'ready' ? { ...current, tools } : current)),
      () => undefined,
    );
  }, []);

  const loadFailure = useCallback((error: unknown) => {
    setState({ kind: 'error', failure: normalizeError(error).detail });
  }, []);

  const installManagedCLI = async (tool: ToolDiagnostic) => {
    if (state.kind !== 'ready' || tool.status !== 'missing' || tool.install === undefined || installingToolKey !== null) {
      return;
    }
    const key = tool.packId + '/' + tool.toolId;
    setInstallingToolKey(key);
    setToolInstallNotice(null);
    try {
      const result = await installTool(
        state.status.csrfToken,
        tool.packId,
        tool.toolId,
        toolInstallRoots[key] ?? '',
      );
      setToolInstallNotice({ key, message: result.message });
    } catch (error) {
      const failure = normalizeError(error).detail;
      setToolInstallNotice({ key, message: failure.message, failure });
    } finally {
      setInstallingToolKey(null);
    }
  };

  const retryStatus = () => {
    setState({ kind: 'loading' });
    setRuntimeAttempt((current) => current + 1);
  };

  useEffect(() => {
    const controller = new AbortController();
    void loadRuntime(controller.signal).then(
      ({ status, tasks, tools }) => {
        if (!controller.signal.aborted) acceptRuntime(status, tasks, tools);
      },
      (error: unknown) => {
        if (!controller.signal.aborted && !isAbort(error)) {
          loadFailure(error);
        }
      },
    );
    return () => controller.abort();
  }, [acceptRuntime, loadFailure, runtimeAttempt]);

  useEffect(() => {
    const handlePopState = () => setRoute(routeFromPath(window.location.pathname));
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    document.title = `${navigationItems.find((item) => item.route === route)?.label} · CLIHarbor`;
    if (previousRouteRef.current !== route) {
      mainRef.current?.focus({ preventScroll: true });
      window.scrollTo(0, 0);
      previousRouteRef.current = route;
    }
  }, [route]);

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

  useEffect(() => {
    if (focusConfigurationRef.current) {
      configurationHeadingRef.current?.focus();
      focusConfigurationRef.current = false;
    }
  }, [formValues]);

  const activeRunID =
    run !== null && run.retained && run.snapshot.status === 'running' ? run.snapshot.runId : null;
  const displayedRunID = run?.snapshot.runId;

  const displayedRunFinished = run !== null && run.snapshot.status !== 'running';
  // Also refocus when a run ends: the Cancel button that had focus disappears.
  useEffect(() => {
    if (displayedRunID !== undefined) resultHeadingRef.current?.focus();
  }, [displayedRunID, displayedRunFinished]);

  useEffect(() => {
    if (activeRunID === null) {
      return;
    }
    const controller = new AbortController();
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
        void fetchRun(activeRunID, controller.signal).then(
          (snapshot) => {
            if (controller.signal.aborted) return;
            if (snapshot.status !== 'running') {
              setCancelRequested(false);
            }
            setRun((current) => (current === null ? current : reconcileRunSnapshot(current, snapshot)));
          },
          (fetchError: unknown) => {
            if (controller.signal.aborted) return;
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
    return () => {
      controller.abort();
      close();
    };
  }, [activeRunID, streamAttempt]);

  const executeRun = async (
    task: Task,
    formSnapshot: Record<string, FormValue>,
    request: CreateRunRequest,
    failureTarget: 'task' | 'run',
  ) => {
    if (state.kind !== 'ready' || startingRef.current || activeRunID !== null) {
      return;
    }
    startingRef.current = true;
    setStarting(true);
    if (failureTarget === 'task') {
      setTaskFailure(null);
    }
    setRunActionFailure(null);
    try {
      const snapshot = await createRun(state.status.csrfToken, request);
      displayedRunIDRef.current = snapshot.runId;
      setRun({
        snapshot,
        streamState: snapshot.status === 'running' ? 'connecting' : 'idle',
        retained: true,
        lastSequence: snapshot.events?.at(-1)?.sequence ?? 0,
        retry: {
          taskKey: task.packId + '/' + task.commandId,
          formValues: cloneFormValues(formSnapshot),
          request: cloneRunRequest(request),
        },
      });
      setCancelRequested(false);
      setStreamAttempt(0);
      updateTaskPreferences((current) => recordRecentTask(current, task));
    } catch (error) {
      const failure = normalizeError(error).detail;
      if (failureTarget === 'task') {
        setTaskFailure(failure);
      } else {
        setRunActionFailure(failure);
      }
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  };

  // Show constraint failures inline (with aria-invalid) instead of the browser's transient bubble.
  const reportInvalidInput = (task: Task): boolean => {
    for (const input of task.inputs) {
      const element = document.getElementById(taskInputDOMID(input.id));
      if (
        (element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) &&
        !element.checkValidity()
      ) {
        const failure = invalidInputError('values.' + input.id).detail;
        setTaskFailure({ ...failure, message: element.validationMessage || failure.message });
        return true;
      }
    }
    return false;
  };

  const startRun = async (event: FormEvent) => {
    event.preventDefault();
    if (state.kind !== 'ready' || selectedTask === undefined || reportInvalidInput(selectedTask)) {
      return;
    }
    setTaskFailure(null);
    try {
      const formSnapshot = cloneFormValues(formValues);
      const request: CreateRunRequest = {
        packId: selectedTask.packId,
        commandId: selectedTask.commandId,
        values: requestValues(selectedTask, formSnapshot),
      };
      await executeRun(selectedTask, formSnapshot, request, 'task');
    } catch (error) {
      setTaskFailure(normalizeError(error).detail);
    }
  };

  const previewSelectedTask = async () => {
    if (state.kind !== 'ready' || selectedTask === undefined || previewing || starting) {
      return;
    }
    if (reportInvalidInput(selectedTask)) return;
    const requestID = previewRequestRef.current + 1;
    previewRequestRef.current = requestID;
    setPreviewing(true);
    setTaskFailure(null);
    try {
      const request: CreateRunRequest = {
        packId: selectedTask.packId,
        commandId: selectedTask.commandId,
        values: requestValues(selectedTask, formValues),
      };
      const preview = await previewRun(state.status.csrfToken, request);
      if (previewRequestRef.current === requestID) {
        setCommandPreview(preview);
      }
    } catch (error) {
      if (previewRequestRef.current === requestID) {
        setCommandPreview(null);
        setTaskFailure(normalizeError(error).detail);
      }
    } finally {
      if (previewRequestRef.current === requestID) {
        setPreviewing(false);
      }
    }
  };

  const retryWithInputs = async () => {
    if (
      state.kind !== 'ready' ||
      run === null ||
      !run.retained ||
      run.snapshot.status === 'running' ||
      starting
    ) {
      return;
    }
    const retry = run.retry;
    const task = state.tasks.find((candidate) => candidate.packId + '/' + candidate.commandId === retry.taskKey);
    if (task === undefined) {
      return;
    }
    const formSnapshot = cloneFormValues(retry.formValues);
    setSelectedTaskKey(retry.taskKey);
    setFormValues(formSnapshot);
    previewRequestRef.current += 1;
    setCommandPreview(null);
    setPreviewing(false);
    setTaskFailure(null);
    await executeRun(task, formSnapshot, cloneRunRequest(retry.request), 'run');
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
    const requestedRunID = run.snapshot.runId;
    try {
      const snapshot = await cancelRun(state.status.csrfToken, requestedRunID);
      if (displayedRunIDRef.current !== requestedRunID) return;
      setRun((current) => (current === null ? current : reconcileRunSnapshot(current, snapshot)));
      if (snapshot.status !== 'running') {
        setCancelRequested(false);
      }
    } catch (error) {
      if (displayedRunIDRef.current !== requestedRunID) return;
      const failure = normalizeError(error).detail;
      setRunActionFailure(failure);
      setCancelRequested(false);
      if (failure.code === 'run_not_found') {
        setRun((current) => (current === null ? current : { ...current, retained: false, streamState: 'stopped' }));
      }
    }
  };

  const taskHasFieldFailure = isTaskFieldFailure(selectedTask, taskFailure);
  const runSnapshot = run?.snapshot;
  // ponytail: decode the bounded retained event log once per update; use an
  // incremental decoder if larger output retention is ever supported.
  const output = useMemo(() => runSnapshot === undefined ? { stdout: '', stderr: '' } : {
    stdout: decodeRunOutput(runSnapshot, 'stdout.chunk'),
    stderr: decodeRunOutput(runSnapshot, 'stderr.chunk'),
  }, [runSnapshot]);
  const runTaskRequiresAuth =
    state.kind === 'ready' &&
    run !== null &&
    state.tasks.some(
      (task) =>
        task.packId === run.snapshot.packId &&
        task.commandId === run.snapshot.commandId &&
        task.requiresAuth === true,
    );

  const hasConjurPack = state.kind === 'ready' && state.tools.some((tool) => tool.packId === conjurPackID);

  const navigate = useCallback((nextRoute: AppRoute) => {
    const nextPath = routePaths[nextRoute];
    if (window.location.pathname !== nextPath) {
      window.history.pushState({}, '', nextPath);
    }
    setRoute(nextRoute);
  }, []);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <header className="topbar">
        <div className="brand-block">
          <span className="eyebrow">LOCAL OPERATOR WORKSPACE</span>
          <h1>CLIHarbor</h1>
        </div>
        <nav className="primary-nav" aria-label="Primary">
          {navigationItems.filter((item) => item.route !== 'secret-audit' || hasConjurPack).map((item) => (
            <a
              key={item.route}
              href={routePaths[item.route]}
              aria-current={route === item.route ? 'page' : undefined}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
                  return;
                }
                event.preventDefault();
                navigate(item.route);
              }}
            >
              <span>{item.label}</span>
              {item.route === 'runs' && activeRunID !== null && (
                <span className="nav-activity" aria-label="Task running">Live</span>
              )}
            </a>
          ))}
        </nav>
        <div className="topbar-context" aria-label="Runtime boundary">
          <span className="local-badge">Local only</span>
          {state.kind === 'ready' && <span className="build-id">{/^\d/.test(state.status.version) ? 'v' : ''}{state.status.version}</span>}
        </div>
      </header>

      <main ref={mainRef} id="main-content" tabIndex={-1} aria-busy={state.kind === 'loading'}>
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

        {state.kind === 'ready' && route === 'authentication' && (
          <AuthenticationPage
            status={state.status}
            tasks={state.tasks}
            tools={state.tools}
            onOpenTasks={() => navigate('tasks')}
            onOpenDiagnostics={() => navigate('diagnostics')}
            onToolsChanged={refreshTools}
          />
        )}

        {state.kind === 'ready' && route === 'runs' && <RunsPage tasks={state.tasks} onOpenTasks={() => navigate('tasks')} />}

        {state.kind === 'ready' && route === 'secret-audit' && (
          <SecretAuditPage
            csrfToken={state.status.csrfToken}
            onOpenAuthentication={() => navigate('authentication')}
            onOpenDiagnostics={() => navigate('diagnostics')}
          />
        )}

        {state.kind === 'ready' && route === 'overview' && (
          <OverviewPage
            status={state.status}
            tasks={state.tasks}
            tools={state.tools}
            preferences={taskPreferences}
            onNavigate={navigate}
            onOpenTask={(taskKey) => {
              selectTaskByKey(taskKey, state.tasks);
              navigate('tasks');
            }}
          />
        )}

        {state.kind === 'ready' && route !== 'authentication' && route !== 'runs' && route !== 'overview' && route !== 'secret-audit' && (
          <>
            <section className="runtime-overview" aria-labelledby="runtime-heading">
              <div className="runtime-copy">
                <p className="runtime-state">Authenticated local runtime</p>
                <h2 id="runtime-heading">
                  {route === 'tasks' ? 'Choose, verify, and run' : 'Tool readiness and setup'}
                </h2>
                <p>
                  {route === 'tasks'
                    ? 'Choose an approved task, check its inputs, and review the result.'
                    : 'Review each configured CLI, fix setup or version issues, and keep authentication separate from executable readiness.'}
                </p>
              </div>
              <dl className="runtime-facts" aria-label="Runtime summary">
                <div>
                  <dt>Version</dt>
                  <dd>{state.status.version}</dd>
                </div>
                <div>
                  <dt>Tools</dt>
                  <dd>{readyToolCount}/{state.tools.length} ready</dd>
                </div>
                <div>
                  <dt>Safe tasks</dt>
                  <dd>{state.tasks.length}</dd>
                </div>
              </dl>
            </section>

            {route === 'tasks' && (
              <section className="workspace-grid">
              <article className="panel task-panel" aria-labelledby="task-heading">
                <p className="status-label">1 · Select</p>
                <h2 id="task-heading">Choose a safe task</h2>
                {state.tasks.length === 0 ? (
                  <div className="empty-state">
                    <strong>No safe tasks are available.</strong>
                    <p>CLIHarbor is still local-only. Load an explicitly trusted pack and resolve its tool readiness, then refresh this runtime.</p>
                  </div>
                ) : (
                  <form ref={taskFormRef} onSubmit={startRun} noValidate>
                    <TaskDiscovery
                      tasks={state.tasks}
                      selectedTaskKey={selectedTaskKey}
                      preferences={taskPreferences}
                      collapsed={taskChosen}
                      disabled={starting || activeRunID !== null}
                      onSelect={(key) => {
                        focusConfigurationRef.current = true;
                        selectTaskByKey(key, state.tasks);
                      }}
                      onToggleFavorite={(task) =>
                        updateTaskPreferences((current) => toggleFavoriteTask(current, task))
                      }
                    />

                    {selectedTask !== undefined && (
                      <>
                        <div className="task-context">
                          <p className="task-step-label">2 · Configure</p>
                          <div className="task-context-header">
                            <h3 ref={configurationHeadingRef} tabIndex={-1}>{selectedTask.name}</h3>
                            <span className="safety-chip">Read-only safe task</span>
                          </div>
                          {selectedTask.description && <p>{selectedTask.description}</p>}
                          {selectedTask.inputs.length === 0 && <p>This task has no inputs. Run it when you are ready.</p>}
                          <details className="technical-details task-technical-details">
                            <summary>Technical task details</summary>
                            <p>
                              Pack: {selectedTask.packName} ({selectedTask.packId}) · Tool: {selectedTask.toolId}
                              {selectedTask.toolVersion ? ' ' + selectedTask.toolVersion : ''} · Command: {selectedTask.commandId}
                            </p>
                            <p>Executable and argument authority stay on the authenticated local runtime.</p>
                          </details>
                          {selectedTask.requiresAuth && (
                            <div className="task-auth-callout">
                              <span>This task requires sign-in. CLIHarbor will not assume an installed tool is already authenticated.</span>
                              <button type="button" className="secondary-button" onClick={() => navigate('authentication')}>
                                Review authentication
                              </button>
                            </div>
                          )}
                        </div>
                        <fieldset className="form-stack" disabled={starting || activeRunID !== null}>
                          <legend className="visually-hidden">Task inputs</legend>
                          {selectedTask.inputs.map((input) => (
                            <InputControl
                              key={input.id}
                              input={input}
                              value={formValues[input.id]}
                              error={fieldFailureFor(input, taskFailure)}
                              onChange={(value) => {
                                setFormValues((current) => ({ ...current, [input.id]: value }));
                                previewRequestRef.current += 1;
                                setCommandPreview(null);
                                setPreviewing(false);
                                if (taskFailure?.field === `values.${input.id}`) {
                                  setTaskFailure(null);
                                }
                              }}
                            />
                          ))}
                        </fieldset>
                        <div className="command-preview" aria-live="polite" aria-busy={previewing}>
                          <div className="command-preview-header">
                            <div>
                              <span className="status-label">3 · Verify</span>
                              <strong>See what CLIHarbor will run</strong>
                            </div>
                            <button
                              type="button"
                              className="secondary-button"
                              disabled={previewing || starting || activeRunID !== null}
                              onClick={() => void previewSelectedTask()}
                            >
                              {previewing ? 'Checking…' : 'Preview command'}
                            </button>
                          </div>
                          {commandPreview === null ? (
                            <p>Preview the validated command before running when you want an extra confirmation.</p>
                          ) : (
                            <>
                              <p className="preview-confirmation">The local runtime validated the task inputs and command boundary.</p>
                              <details className="technical-details command-technical-details">
                                <summary>Show exact command</summary>
                                <code className="invocation-preview">{formatInvocation(commandPreview)}</code>
                                <p className="preview-note">
                                  Display only. CLIHarbor executes the trusted executable path and argv directly; this text is never reparsed.
                                </p>
                              </details>
                            </>
                          )}
                        </div>
                        <div className="task-actions">
                          <button type="submit" disabled={starting || activeRunID !== null}>
                            {starting ? 'Starting…' : 'Run task'}
                          </button>
                          <button
                            type="button"
                            className="secondary-button"
                            disabled={starting || activeRunID !== null || JSON.stringify(formValues) === JSON.stringify(initialValues(selectedTask))}
                            onClick={() => selectTaskByKey(selectedTask.packId + '/' + selectedTask.commandId, state.tasks)}
                          >
                            Reset inputs
                          </button>
                        </div>
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

              <article className={"panel run-panel" + (run !== null ? " run-panel--engaged" : "")} aria-labelledby="run-heading">
                <p className="status-label">4 · Result</p>
                <div className={"run-state run-state--" + (run === null ? "idle" : run.retained ? runOutcomeTone(run.snapshot.status, run.snapshot.exitCode) : "unavailable")} role="status" aria-live="polite" aria-atomic="true">
                  <h2 ref={resultHeadingRef} id="run-heading" tabIndex={-1}>{run === null ? 'No active run' : run.retained ? runOutcomeHeading(run.snapshot.status, run.snapshot.exitCode) : 'Run no longer retained'}</h2>
                  <p>{run === null ? 'Start a safe task to stream its output here.' : runStatusDescription(run, cancelRequested)}</p>
                </div>
                {run !== null && (
                  <>
                    <p className="run-task-name">{state.tasks.find((task) => task.packId + '/' + task.commandId === run.retry.taskKey)?.name ?? run.snapshot.commandId}</p>
                    {run.snapshot.startedAt !== undefined && (
                      <RunTiming startedAt={run.snapshot.startedAt} endedAt={run.snapshot.status === 'running' ? undefined : run.snapshot.endedAt} />
                    )}
                    <details className="technical-details run-technical-details">
                      <summary>Run technical details</summary>
                      <dl className="run-meta">
                        <div>
                          <dt>Run ID</dt>
                          <dd>{run.snapshot.runId}</dd>
                        </div>
                        <div>
                          <dt>Runtime status</dt>
                          <dd>{run.snapshot.status}</dd>
                        </div>
                        <div>
                          <dt>Exit code</dt>
                          <dd>{run.snapshot.exitCode ?? '—'}</dd>
                        </div>
                      </dl>
                    </details>
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
                    {run.retained &&
                      run.snapshot.status !== 'running' &&
                      state.tasks.some((task) => task.packId + '/' + task.commandId === run.retry.taskKey) && (
                        <div className="run-actions">
                          <button
                            type="button"
                            className="secondary-button"
                            disabled={starting}
                            onClick={() => void retryWithInputs()}
                          >
                            {starting ? 'Starting…' : 'Retry with inputs'}
                          </button>
                        </div>
                      )}
                    {run.streamFailure && (
                      <FailureNotice title={run.retained ? 'Live updates interrupted' : 'Run unavailable'} failure={run.streamFailure} />
                    )}
                    {run.snapshot.failure && <FailureNotice title="Run failure" failure={run.snapshot.failure} />}
                    {runActionFailure && <FailureNotice title="Run action failed" failure={runActionFailure} />}
                    {runTaskRequiresAuth &&
                      run.retained &&
                      run.snapshot.status === 'exited' &&
                      run.snapshot.exitCode !== undefined &&
                      run.snapshot.exitCode !== 0 && (
                        <div className="task-auth-callout task-auth-callout--run">
                          <span>This task requires a vendor session and failed. Check Authentication to verify the session is still usable.</span>
                          <button type="button" className="secondary-button" onClick={() => navigate('authentication')}>
                            Review authentication
                          </button>
                        </div>
                      )}
                    {run.snapshot.structured && (
                      <section className="structured-result" aria-labelledby="structured-result-heading">
                        <h3 id="structured-result-heading">Structured result</h3>
                        {run.snapshot.structured.status === 'available' ? (
                          <StructuredResultView fields={run.snapshot.structured.fields ?? []} />
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
                    <details className="raw-output" open={run.snapshot.structured?.status !== 'available'}>
                      <summary>
                        <span>Raw process output</span>
                        <span className="raw-output-note">stdout and stderr remain separate</span>
                      </summary>
                      <div className="output-grid">
                        <OutputStream name="stdout" text={output.stdout} live={run.snapshot.status === 'running'} />
                        <OutputStream name="stderr" text={output.stderr} live={run.snapshot.status === 'running'} />
                      </div>
                    </details>
                  </>
                )}
              </article>
              </section>
            )}

            {route === 'diagnostics' && (
              <section className="panel tool-diagnostics" aria-labelledby="tool-diagnostics-heading">
              <div className="tool-diagnostics-heading">
                <span className="diagnostics-summary-copy">
                  <span className="status-label">Diagnostics</span>
                  <strong id="tool-diagnostics-heading">Tool readiness</strong>
                </span>
                <span className="summary-meta">{readyToolCount}/{state.tools.length} ready</span>
              </div>
              <div className="diagnostics-body" aria-label="Configured CLI tool diagnostics">
                {state.tools.length === 0 ? (
                  <div className="empty-state">
                    <strong>No tools are configured.</strong>
                    <p>No approved CLI tools are currently available to the browser. Check startup configuration and trusted packs.</p>
                  </div>
                ) : (
                  <ul className="tool-list">
                    {state.tools.map((tool) => {
                      const toolView = describeToolReadiness(tool);
                      return (
                        <li key={tool.packId + '/' + tool.toolId}>
                          <div className="tool-summary">
                            <strong>{toolView.heading}</strong>
                            <span className={"tool-status " + (toolView.ready ? 'tool-status--ready' : 'tool-status--attention')}>
                              {toolView.statusText}
                            </span>
                          </div>
                          <p>{toolView.summary}</p>
                          <p className="tool-next-step"><strong>Next:</strong> {toolView.nextStep}</p>
                          {tool.status === 'ready' && tool.requiresVendorSession && (
                            <div className="tool-install-actions">
                              <button type="button" className="secondary-button" onClick={() => navigate('authentication')}>
                                Check sign-in status
                              </button>
                            </div>
                          )}
                          {tool.status === 'missing' && tool.install !== undefined && (
                            <div className="tool-install-controls">
                              {tool.install.customLocation && (
                                <label className="tool-install-location">
                                  <span>Install base directory <span className="field-requirement">Optional</span></span>
                                  <input
                                    type="text"
                                    value={toolInstallRoots[tool.packId + '/' + tool.toolId] ?? ''}
                                    disabled={installingToolKey !== null}
                                    placeholder="Leave blank for CLIHarbor's default user cache"
                                    autoComplete="off"
                                    spellCheck={false}
                                    onChange={(event) => {
                                      const key = tool.packId + '/' + tool.toolId;
                                      setToolInstallRoots((current) => ({ ...current, [key]: event.target.value }));
                                    }}
                                  />
                                  <small>Custom locations must be absolute paths inside your user home directory.</small>
                                </label>
                              )}
                              <div className="tool-install-actions">
                                <button
                                  type="button"
                                  disabled={installingToolKey !== null}
                                  onClick={() => void installManagedCLI(tool)}
                                >
                                  {installingToolKey === tool.packId + '/' + tool.toolId
                                    ? 'Installing…'
                                    : 'Install ' + tool.packName}
                                </button>
                                <span>Verified current-user install · no admin credentials · restart required to activate</span>
                              </div>
                            </div>
                          )}
                          {toolInstallNotice?.key === tool.packId + '/' + tool.toolId && (
                            <div
                              className={toolInstallNotice.failure ? 'tool-install-result tool-install-result--error' : 'tool-install-result'}
                              role={toolInstallNotice.failure ? 'alert' : 'status'}
                            >
                              <p>{toolInstallNotice.message}</p>
                              {toolInstallNotice.failure?.remediation && <p>{toolInstallNotice.failure.remediation}</p>}
                            </div>
                          )}
                          <details className="technical-details tool-technical-details">
                            <summary>Technical details</summary>
                            <p>
                              Pack: {tool.packName} ({tool.packId}) · Pack version: {tool.packVersion} · Tool ID: {tool.toolId}
                            </p>
                            <p>
                              Runtime status: {tool.status}
                              {tool.version ? ' · Detected version: ' + tool.version : ''}
                              {tool.versionConstraint ? ' · Required version: ' + tool.versionConstraint : ''}
                            </p>
                            {tool.message && <p>Runtime detail: {tool.message}</p>}
                          </details>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
              </section>
            )}
          </>
        )}
      </main>

      <footer>
        <p>Local runtime · No cloud backend · No telemetry by default · No remote runtime assets</p>
      </footer>
    </div>
  );
}

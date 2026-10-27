import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { clientError, normalizeError, invalidInputError, type AppErrorDetail } from './api/errors';
import { fetchRuntimeStatus, type RuntimeStatus } from './api/status';
import { fetchTasks, type Task, type TaskInput } from './api/tasks';
import { fetchTools, installTool, refreshTool, type ToolDiagnostic } from './api/tools';
import {
  cancelRun,
  createRun,
  createRunOutputDecoder,
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
import { AuthenticationPage, authenticationContextKey, type AuthenticationCheck, type AuthenticationChecks } from './AuthenticationPage';
import { CliSessionStatus } from './CliSessionStatus';
import { WorkingStatus } from './WorkingStatus';
import { OperationActivity, OperationActivityProvider, useOperationActivity, useWorkingActivity } from './OperationActivity';
import { ExecutionContext, OperationResult } from './OperationResult';
import { RunsPage, formatDuration, formatTimestamp } from './RunsPage';
import { SecretAuditPage } from './platforms/conjur/SecretAuditPage';
import { ConjurAccessExplorer } from './platforms/conjur/ConjurAccessExplorer';
import { OverviewPage } from './OverviewPage';
import { PlatformPage, PlatformsPage } from './PlatformPage';
import { dedicatedSignIn } from './platforms';
import { fetchPlatforms, type Platform, type PlatformFeatureID } from './api/platforms';
import { ToolsPage } from './ToolsPage';
import { TaskDiscovery, taskToolKey } from './TaskDiscovery';
import { TaskSwitcher } from './TaskSwitcher';
import { ToolExplorer } from './ToolExplorer';
import { ExecutionPreflight } from './ExecutionPreflight';
import { OutputExplorer } from './OutputExplorer';
import { inputGuidance, runOutcomeHeading, runOutcomeTone } from './operatorLanguage';
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
  context?: RunPreview['context'];
  target?: string;
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
): Promise<{ status: RuntimeStatus; tasks: Task[]; tools: ToolDiagnostic[]; platforms: Platform[] }> {
  const status = await fetchRuntimeStatus(signal);
  // Dedicated platforms are additive: if their list cannot load, the generic
  // workspace keeps working and the Dedicated section simply stays hidden.
  const [tasks, tools, platforms] = await Promise.all([
    fetchTasks(signal),
    fetchTools(signal),
    fetchPlatforms(signal).catch((error: unknown) => { if (isAbort(error)) throw error; return []; }),
  ]);
  return { status, tasks, tools, platforms };
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

// Secret values live only in the field until a run starts; retry copies never keep them.
function withoutSecretValues(task: Task, values: Record<string, FormValue>): Record<string, FormValue> {
  const cleared = cloneFormValues(values);
  for (const input of task.inputs) {
    if (input.type === 'secret') cleared[input.id] = '';
  }
  return cleared;
}

function withoutSecretRequestValues(task: Task, request: CreateRunRequest): CreateRunRequest {
  const cloned = cloneRunRequest(request);
  for (const input of task.inputs) {
    if (input.type === 'secret') delete cloned.values[input.id];
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
          type={input.type === 'integer' ? 'number' : input.type === 'secret' ? 'password' : 'text'}
          autoComplete={input.type === 'secret' ? 'off' : undefined}
          spellCheck={input.type === 'secret' ? false : undefined}
          required={input.required}
          value={typeof value === 'string' ? value : ''}
          step={input.type === 'integer' ? 1 : undefined}
          min={input.type === 'integer' ? validation.min : undefined}
          max={input.type === 'integer' ? validation.max : undefined}
          minLength={input.type === 'string' || input.type === 'secret' ? validation.minLength : undefined}
          maxLength={input.type === 'string' || input.type === 'secret' ? validation.maxLength : undefined}
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

// Browser-memory activity log for the Command Builder. Holds task names, run
// IDs and safe messages only; never inputs, argv, output or credentials.
interface ActivityEntry {
  id: number;
  at: Date;
  level: 'INFO' | 'WARN' | 'ERROR';
  message: string;
  tag?: string;
  tone?: 'succeeded' | 'running' | 'failed' | 'cancelled' | 'timed-out' | 'pending';
}

function formatActivityTime(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

type AppRoute = 'overview' | 'authentication' | 'tasks' | 'runs' | 'secret-audit' | 'access-explorer' | 'tools' | 'diagnostics' | 'platforms' | 'platform';

const routePaths: Record<AppRoute, string> = {
  overview: '/',
  authentication: '/authentication',
  tasks: '/tasks',
  runs: '/runs',
  'secret-audit': '/dedicated/conjur/security-audit',
  'access-explorer': '/dedicated/conjur/access-explorer',
  tools: '/tools',
  diagnostics: '/diagnostics',
  platforms: '/dedicated',
  platform: '/dedicated',
};

// The app has two halves: the generic workspace above works with any CLI, and
// a dedicated CLI (selected from the top bar) adds functionality built and tested
// for that one platform. Platform IDs come from /api/v1/platforms.
const dedicatedPathPattern = /^\/dedicated\/([a-z0-9-]{1,64})$/;
// Legacy per-platform sign-in links now open the universal sign-in page.
const legacySignInPathPattern = /^\/dedicated\/[a-z0-9-]{1,64}\/sign-in$/;

function platformIDFromPath(pathname: string): string {
  if (pathname === routePaths['secret-audit'] || pathname === '/conjur/security-audit' || pathname === '/secret-audit' || pathname === routePaths['access-explorer']) return 'conjur';
  return dedicatedPathPattern.exec(pathname)?.[1] ?? '';
}

function pathForRoute(route: AppRoute, platformID: string): string {
  if (platformID === '') return routePaths[route];
  if (route === 'platform') return `${routePaths.platform}/${platformID}`;
  return routePaths[route];
}

const navigationItems: Array<{ route: AppRoute; label: string; group: string; icon: string }> = [
  { route: 'overview', label: 'Overview', group: 'Workspace', icon: 'M3 11.5 12 4l9 7.5 M5.5 9.5V20h13V9.5 M10 20v-5h4v5' },
  { route: 'tasks', label: 'Command Builder', group: 'Workspace', icon: 'M4 4h16v16H4z m4 5 3 3-3 3 M13 15h3' },
  { route: 'runs', label: 'Execution History', group: 'Workspace', icon: 'M3 12a9 9 0 1 0 3-6 M3 3v6h6 M12 7v5l3 2' },
  { route: 'tools', label: 'Add a CLI', group: 'Manage', icon: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M17.5 14v7 M14 17.5h7' },
  { route: 'diagnostics', label: 'Diagnostics', group: 'Manage', icon: 'M3 12h4l3-8 4 16 3-8h4' },
  { route: 'secret-audit', label: 'Conjur security audit', group: 'Dedicated', icon: 'M14 3H5v18h14V8z M14 3v5h5 M8 12h7 M8 16h5' },
  { route: 'access-explorer', label: 'Conjur access explorer', group: 'Dedicated', icon: 'M12 2v20 M2 12h20 M6 6l12 12' },
  { route: 'platforms', label: 'Built-in CLIs', group: 'Dedicated', icon: '' },
  { route: 'platform', label: 'Dedicated CLI', group: 'Dedicated', icon: 'M4 6h16v12H4z M8 10l3 2-3 2 M13 14h3' },
  // Reached from the top-right Sign in button rather than the sidebar.
  { route: 'authentication', label: 'Sign in', group: 'Account', icon: '' },
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
    case '/conjur/security-audit':
    case routePaths['secret-audit']:
      return 'secret-audit';
    case '/tools':
      return 'tools';
    case routePaths['access-explorer']:
      return 'access-explorer';
    case '/diagnostics':
      return 'diagnostics';
    case routePaths.platforms:
      return 'platforms';
    default:
      if (dedicatedPathPattern.test(pathname)) return 'platform';
      return legacySignInPathPattern.test(pathname) ? 'authentication' : 'overview';
  }
}

export function App() {
  return <OperationActivityProvider><WorkspaceApp /></OperationActivityProvider>;
}

function WorkspaceApp() {
  const { confirmNavigation, local } = useOperationActivity();
  const lastPathRef = useRef(window.location.pathname + window.location.search);
  const [requestedRun, setRequestedRun] = useState<{ runId: string } | undefined>(() => {
    const id = new URLSearchParams(window.location.search).get('run');
    return id && /^[0-9a-f]{32}$/.test(id) ? { runId: id } : undefined;
  });
  const [quickCheck, setQuickCheck] = useState<{ toolKey: string; id: number } | null>(null);
  const quickCheckSequence = useRef(0);
  const clearQuickCheck = useCallback(() => setQuickCheck(null), []);
  const [refreshingToolKey, setRefreshingToolKey] = useState<string | null>(null);
  const [authenticationChecks, setAuthenticationChecks] = useState<AuthenticationChecks>({});
  const recordAuthenticationCheck = useCallback((tool: ToolDiagnostic, check: AuthenticationCheck) => {
    setAuthenticationChecks((current) => ({
      ...current,
      [tool.packId + '/' + tool.toolId]: { context: authenticationContextKey(tool), check },
    }));
  }, []);
  const [state, setState] = useState<ViewState>({ kind: 'loading' });
  const [runtimeAttempt, setRuntimeAttempt] = useState(0);
  const [route, setRoute] = useState<AppRoute>(() => routeFromPath(window.location.pathname));
  const [selectedTaskKey, setSelectedTaskKey] = useState('');
  const [taskChosen, setTaskChosen] = useState(false);
  const [taskToolFilter, setTaskToolFilter] = useState('');
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [taskSwitcherOpen, setTaskSwitcherOpen] = useState(false);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [selectedPlatformID, setSelectedPlatformID] = useState(() => platformIDFromPath(window.location.pathname));
  const [taskPreferences, setTaskPreferences] = useState<TaskPreferences>(() => loadTaskPreferences());
  const [formValues, setFormValues] = useState<Record<string, FormValue>>({});
  const [run, setRun] = useState<RunView | null>(null);
  const [taskFailure, setTaskFailure] = useState<AppErrorDetail | null>(null);
  const [runActionFailure, setRunActionFailure] = useState<AppErrorDetail | null>(null);
  const [commandPreview, setCommandPreview] = useState<RunPreview | null>(null);
  const [approvalConfirmation, setApprovalConfirmation] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [streamAttempt, setStreamAttempt] = useState(0);
  const [installingToolKey, setInstallingToolKey] = useState<string | null>(null);
  useWorkingActivity(refreshingToolKey !== null || installingToolKey !== null,
    refreshingToolKey !== null ? 'Checking CLI installation…' : 'Installing and verifying CLI…', false, '/tools');
  const [toolInstallNotice, setToolInstallNotice] = useState<{ key: string; message: string; failure?: AppErrorDetail } | null>(null);
  const [toolInstallRoots, setToolInstallRoots] = useState<Record<string, string>>({});
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [outputTab, setOutputTab] = useState<'output' | 'activity'>('output');
  const [copyResult, setCopyResult] = useState<{ preview: RunPreview; copied: boolean } | null>(null);
  const runtimeErrorRef = useRef<HTMLElement>(null);
  const taskErrorRef = useRef<HTMLDivElement>(null);
  const resultHeadingRef = useRef<HTMLHeadingElement>(null);
  const configurationHeadingRef = useRef<HTMLHeadingElement>(null);
  const focusConfigurationRef = useRef(false);
  const mainRef = useRef<HTMLElement>(null);
  const taskFormRef = useRef<HTMLFormElement>(null);
  const previousRouteRef = useRef(route);
  const startingRef = useRef(false);
  const installingToolRef = useRef(false);
  const displayedRunIDRef = useRef<string | null>(null);
  const previewRequestRef = useRef(0);

  const updateTaskPreferences = useCallback((update: (current: TaskPreferences) => TaskPreferences) => {
    setTaskPreferences((current) => {
      const next = update(current);
      saveTaskPreferences(next);
      return next;
    });
  }, []);

  const activitySequenceRef = useRef(0);
  const logActivity = useCallback((entry: Omit<ActivityEntry, 'id' | 'at'>) => {
    activitySequenceRef.current += 1;
    const next = { ...entry, id: activitySequenceRef.current, at: new Date() };
    // ponytail: keeps the newest 200 entries in memory; no persistence by design.
    setActivity((current) => [...current.slice(-199), next]);
  }, []);

  const selectTaskByKey = useCallback((key: string, tasks: Task[], prefill?: Record<string, string>) => {
    const task = tasks.find((candidate) => candidate.packId + '/' + candidate.commandId === key);
    if (task === undefined) {
      return;
    }
    setSelectedTaskKey(key);
    setTaskChosen(true);
    const values = initialValues(task);
    for (const input of task.inputs) {
      const candidate = prefill?.[input.id];
      if (candidate === undefined) continue;
      if (input.type === 'string' && candidate.length <= (input.validation?.maxLength ?? 2048) &&
          !/[\p{Cc}\p{Cf}]/u.test(candidate) && !candidate.startsWith('-')) values[input.id] = candidate;
      if (input.type === 'enum' && input.validation?.enum?.includes(candidate)) values[input.id] = candidate;
    }
    setFormValues(values);
    previewRequestRef.current += 1;
    setCommandPreview(null);
    setApprovalConfirmation('');
    setPreviewing(false);
    setTaskFailure(null);
  }, []);

  const readyToolCount = state.kind === 'ready' ? state.tools.filter((tool) => tool.status === 'ready').length : 0;

  const selectedTask = useMemo(() => {
    if (state.kind !== 'ready') {
      return undefined;
    }
    const tasks = state.tasks.filter((task) => taskToolFilter === '' || taskToolKey(task) === taskToolFilter);
    return tasks.find((task) => `${task.packId}/${task.commandId}` === selectedTaskKey) ?? tasks[0];
  }, [selectedTaskKey, state, taskToolFilter]);

  const acceptRuntime = useCallback((status: RuntimeStatus, tasks: Task[], tools: ToolDiagnostic[]) => {
    setAuthenticationChecks({});
    setState({ kind: 'ready', status, tasks, tools });
    setTaskSwitcherOpen(false);
    setTaskToolFilter('');
    previewRequestRef.current += 1;
    setCommandPreview(null);
    setApprovalConfirmation('');
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

  const toolsRequestRef = useRef(0);
  const refreshTools = useCallback(() => {
    // Best effort: on failure the current snapshot stays and a reload recovers.
    // Only the newest refresh may land, so a slow older response cannot win.
    const request = ++toolsRequestRef.current;
    void fetchTools().then(
      (tools) => {
        if (toolsRequestRef.current === request) setState((current) => (current.kind === 'ready' ? { ...current, tools } : current));
      },
      () => undefined,
    );
    void fetchPlatforms().then((next) => {
      if (toolsRequestRef.current === request) setPlatforms(next);
    }, () => undefined);
  }, []);

  const loadFailure = useCallback((error: unknown) => {
    setAuthenticationChecks({});
    setState({ kind: 'error', failure: normalizeError(error).detail });
  }, []);

  const installManagedCLI = async (tool: ToolDiagnostic) => {
    if (state.kind !== 'ready' || tool.status !== 'missing' || tool.install === undefined || installingToolRef.current || Object.keys(local).length > 0) {
      return;
    }
    const key = tool.packId + '/' + tool.toolId;
    installingToolRef.current = true;
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
      if (!result.restartRequired) {
        try {
          const [tasks, tools] = await Promise.all([fetchTasks(), fetchTools()]);
          toolsRequestRef.current += 1; // supersede any older in-flight refresh
          setState((current) => current.kind === 'ready' ? { ...current, tasks, tools } : current);
          // Installing a dedicated platform's CLI flips that platform to ready.
          void fetchPlatforms().then(setPlatforms, () => undefined);
          if (state.tasks.length === 0 && tasks[0]) selectTaskByKey(tasks[0].packId + '/' + tasks[0].commandId, tasks);
        } catch {
          setToolInstallNotice({ key, message: 'CLI installed and verified. Reload this page to show its approved tasks.' });
        }
      }
    } catch (error) {
      const failure = normalizeError(error).detail;
      setToolInstallNotice({ key, message: failure.message, failure });
    } finally {
      installingToolRef.current = false;
      setInstallingToolKey(null);
    }
  };

  const refreshMissingCLI = async (tool: ToolDiagnostic) => {
    if (state.kind !== 'ready' || tool.status !== 'missing' || installingToolRef.current || Object.keys(local).length > 0) return;
    const key = tool.packId + '/' + tool.toolId;
    installingToolRef.current = true;
    setRefreshingToolKey(key);
    setToolInstallNotice(null);
    try {
      const result = await refreshTool(state.status.csrfToken, tool.packId, tool.toolId);
      setToolInstallNotice({ key, message: result.message });
      if (result.ready) {
        const [tasks, tools, nextPlatforms] = await Promise.all([fetchTasks(), fetchTools(), fetchPlatforms()]);
        toolsRequestRef.current += 1;
        setState((current) => current.kind === 'ready' ? { ...current, tasks, tools } : current);
        setPlatforms(nextPlatforms);
        if (state.tasks.length === 0 && tasks[0]) selectTaskByKey(tasks[0].packId + '/' + tasks[0].commandId, tasks);
      }
    } catch (error) {
      const failure = normalizeError(error).detail;
      setToolInstallNotice({ key, message: failure.message + ' Reload Diagnostics to reconcile tool readiness before retrying.', failure });
    } finally {
      installingToolRef.current = false;
      setRefreshingToolKey(null);
    }
  };

  const retryStatus = () => {
    setTaskSwitcherOpen(false);
    setState({ kind: 'loading' });
    setRuntimeAttempt((current) => current + 1);
  };

  useEffect(() => {
    const controller = new AbortController();
    void loadRuntime(controller.signal).then(
      ({ status, tasks, tools, platforms: loadedPlatforms }) => {
        if (controller.signal.aborted) return;
        setPlatforms(loadedPlatforms);
        acceptRuntime(status, tasks, tools);
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
    const handlePopState = () => {
      if (!confirmNavigation(window.location.pathname, new URL(lastPathRef.current, window.location.origin).pathname)) {
        window.history.pushState({}, '', lastPathRef.current);
        return;
      }
      lastPathRef.current = window.location.pathname + window.location.search;
      setNavigationOpen(false);
      setRoute(routeFromPath(window.location.pathname));
      const pathPlatform = platformIDFromPath(window.location.pathname);
      if (pathPlatform !== '') setSelectedPlatformID(pathPlatform);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [confirmNavigation]);

  useEffect(() => {
    const linkedPlatform = platforms.find((platform) => platform.id === platformIDFromPath(window.location.pathname));
    const pageTitle = route === 'platform'
      ? linkedPlatform?.name ?? 'Dedicated CLI unavailable'
      : navigationItems.find((item) => item.route === route)?.label ?? 'CLIHarbor';
    document.title = `${pageTitle} · CLIHarbor`;
    if (previousRouteRef.current !== route) {
      mainRef.current?.focus({ preventScroll: true });
      window.scrollTo(0, 0);
      previousRouteRef.current = route;
    }
  }, [route, selectedPlatformID, platforms]);

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
  const taskSwitcherAvailable = state.kind === 'ready' && state.tasks.length > 0 && !starting && activeRunID === null;

  useEffect(() => {
    if (!taskSwitcherAvailable) return;
    const openTaskSwitcher = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat ||
          event.key.toLowerCase() !== 'k' || !(event.ctrlKey || event.metaKey) ||
          event.altKey || event.shiftKey) return;
      const target = event.target;
      if (target instanceof HTMLElement &&
          (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
      event.preventDefault();
      setTaskSwitcherOpen(true);
    };
    document.addEventListener('keydown', openTaskSwitcher);
    return () => document.removeEventListener('keydown', openTaskSwitcher);
  }, [taskSwitcherAvailable]);

  const displayedRunFinished = run !== null && run.snapshot.status !== 'running';
  // Also refocus when a run ends: the Cancel button that had focus disappears.
  useLayoutEffect(() => {
    if (displayedRunID !== undefined) resultHeadingRef.current?.focus();
  }, [displayedRunID, displayedRunFinished]);

  const loggedOutcomeRef = useRef('');
  const finishedStatus = displayedRunFinished && run.retained ? run.snapshot.status : undefined;
  const finishedExitCode = run?.snapshot.exitCode;
  useEffect(() => {
    if (displayedRunID === undefined || finishedStatus === undefined || loggedOutcomeRef.current === displayedRunID) return;
    loggedOutcomeRef.current = displayedRunID;
    const tone = runOutcomeTone(finishedStatus, finishedExitCode);
    logActivity({
      level: tone === 'succeeded' ? 'INFO' : 'WARN',
      message: `Run ${displayedRunID} finished${finishedExitCode === undefined ? '' : ' with exit code ' + finishedExitCode}`,
      tag: runOutcomeHeading(finishedStatus, finishedExitCode),
      tone,
    });
  }, [displayedRunID, finishedStatus, finishedExitCode, logActivity]);

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
    if (state.kind !== 'ready' || previewing || startingRef.current || activeRunID !== null) {
      return;
    }
    startingRef.current = true;
    setTaskSwitcherOpen(false);
    setStarting(true);
    if (failureTarget === 'task') {
      setTaskFailure(null);
    }
    setRunActionFailure(null);
    try {
      const snapshot = await createRun(state.status.csrfToken, request);
      displayedRunIDRef.current = snapshot.runId;
      setOutputTab('output');
      setRun({
        context: commandPreview?.packId === task.packId && commandPreview.commandId === task.commandId ? commandPreview.context : undefined,
        target: commandPreview?.packId === task.packId && commandPreview.commandId === task.commandId ? commandPreview.impact?.target : undefined,
        snapshot,
        streamState: snapshot.status === 'running' ? 'connecting' : 'idle',
        retained: true,
        lastSequence: snapshot.events?.at(-1)?.sequence ?? 0,
        retry: {
          taskKey: task.packId + '/' + task.commandId,
          formValues: withoutSecretValues(task, formSnapshot),
          request: withoutSecretRequestValues(task, request),
        },
      });
      if (task.inputs.some((input) => input.type === 'secret')) {
        setFormValues((current) => withoutSecretValues(task, current));
      }
      setCancelRequested(false);
      setStreamAttempt(0);
      updateTaskPreferences((current) => recordRecentTask(current, task));
      logActivity({ level: 'INFO', message: `Execution started: ${task.name} (run ${snapshot.runId})`, tag: 'Running', tone: 'running' });
    } catch (error) {
      const failure = normalizeError(error).detail;
      const unknown = failure.code === 'run_start_unknown';
      logActivity({ level: unknown ? 'WARN' : 'ERROR', message: `${unknown ? 'Run start unconfirmed' : 'Run could not start'}: ${failure.message}`, tag: unknown ? 'Unconfirmed' : 'Failed', tone: unknown ? 'pending' : 'failed' });
      if (failureTarget === 'task') {
        setTaskFailure(failure);
      } else {
        setRunActionFailure(failure);
      }
    } finally {
      // The server consumes an approval when it accepts (or audits) the run, so
      // never leave a spent approval on screen as if it could be reused.
      if (request.approval !== undefined) {
        previewRequestRef.current += 1;
        setCommandPreview(null);
        setApprovalConfirmation('');
      }
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
      if (selectedTask.risk !== 'read') {
        const approval = commandPreview?.approval;
        if (
          commandPreview === null ||
          commandPreview.packId !== selectedTask.packId ||
          commandPreview.commandId !== selectedTask.commandId ||
          commandPreview.risk !== selectedTask.risk ||
          approval === undefined ||
          (approval.mode === 'typed' && approvalConfirmation !== approval.requiredText)
        ) {
          setTaskFailure({
            code: 'approval_required',
            category: 'policy',
            message: 'This change requires a fresh explicit approval.',
            remediation: 'Review the exact target and environment below, then complete the required approval.',
            retryable: false,
          });
          return;
        }
        request.approval = {
          id: approval.id,
          ...(approval.mode === 'typed' ? { confirmation: approvalConfirmation } : {}),
        };
      }
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
    logActivity({ level: 'INFO', message: `Validation started: ${selectedTask.name}`, tag: 'Checking', tone: 'pending' });
    try {
      const request: CreateRunRequest = {
        packId: selectedTask.packId,
        commandId: selectedTask.commandId,
        values: requestValues(selectedTask, formValues),
      };
      const preview = await previewRun(state.status.csrfToken, request);
      if (
        preview.packId !== selectedTask.packId ||
        preview.commandId !== selectedTask.commandId ||
        preview.risk !== selectedTask.risk
      ) {
        throw clientError('invalid_response');
      }
      if (previewRequestRef.current === requestID) {
        setCommandPreview(preview);
        setApprovalConfirmation('');
        logActivity({ level: 'INFO', message: `Inputs validated; command prepared for ${selectedTask.name}`, tag: 'Passed', tone: 'succeeded' });
      }
    } catch (error) {
      if (previewRequestRef.current === requestID) {
        const failure = normalizeError(error).detail;
        setCommandPreview(null);
        setTaskFailure(failure);
        logActivity({ level: 'ERROR', message: `Validation failed: ${failure.message}`, tag: 'Failed', tone: 'failed' });
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
    // selectedTask only searches the filtered list; a filter set since the
    // run would otherwise show (and review) a different task.
    if (taskToolFilter !== '' && taskToolFilter !== taskToolKey(task)) setTaskToolFilter(taskToolKey(task));
    setSelectedTaskKey(retry.taskKey);
    setFormValues(formSnapshot);
    previewRequestRef.current += 1;
    setCommandPreview(null);
    setApprovalConfirmation('');
    setPreviewing(false);
    setTaskFailure(null);
    if (task.risk !== 'read') {
      focusConfigurationRef.current = true;
      setRunActionFailure(null);
      return;
    }
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
    logActivity({ level: 'WARN', message: `Cancellation requested for run ${requestedRunID}`, tag: 'Cancelling', tone: 'cancelled' });
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
  const mutationTask = selectedTask !== undefined && selectedTask.risk !== 'read';
  const mutationApprovalReady =
    mutationTask &&
    commandPreview !== null &&
    commandPreview.packId === selectedTask?.packId &&
    commandPreview.commandId === selectedTask?.commandId &&
    commandPreview.risk === selectedTask?.risk &&
    commandPreview.approval !== undefined &&
    (commandPreview.approval.mode === 'explicit' ||
      approvalConfirmation === commandPreview.approval.requiredText);
  const runTask =
    state.kind === 'ready' && run !== null
      ? state.tasks.find(
          (task) => task.packId === run.snapshot.packId && task.commandId === run.snapshot.commandId,
        )
      : undefined;
  const runSnapshot = run?.snapshot;
  useWorkingActivity(starting || activeRunID !== null,
    starting ? 'Starting command…' : cancelRequested ? 'Stopping command…' : 'Command running…',
    starting ? selectedTask?.risk !== 'read' : runTask?.risk !== 'read', '/tasks', 'command-work-progress');
  const [decodeOutput] = useState(createRunOutputDecoder);
  const output = useMemo(
    () => (runSnapshot === undefined ? { stdout: '', stderr: '' } : decodeOutput(runSnapshot)),
    [decodeOutput, runSnapshot],
  );
  const runTaskRequiresAuth =
    state.kind === 'ready' &&
    run !== null &&
    state.tasks.some(
      (task) =>
        task.packId === run.snapshot.packId &&
        task.commandId === run.snapshot.commandId &&
        task.requiresAuth === true,
    );

  // An explicit dedicated URL is authoritative. Never silently substitute
  // another vendor's integration for an unknown or removed platform ID.
  const dedicatedPathID = route === 'platform'
    ? platformIDFromPath(window.location.pathname)
    : '';
  const activePlatform = dedicatedPathID
    ? platforms.find((platform) => platform.id === dedicatedPathID)
    : (platforms.find((platform) => platform.id === selectedPlatformID) ?? platforms[0]);
  const activePlatformID = activePlatform?.id ?? '';

  const navigate = useCallback((nextRoute: AppRoute, platformID: string = activePlatformID) => {
    const nextPath = pathForRoute(nextRoute, platformID);
    if (!confirmNavigation(nextPath)) return false;
    if (window.location.pathname !== nextPath) {
      window.history.pushState({}, '', nextPath);
    }
    setRoute(nextRoute);
    setNavigationOpen(false);
    lastPathRef.current = nextPath;
    mainRef.current?.focus({ preventScroll: true });
    return true;
  }, [activePlatformID, confirmNavigation]);

  const changeTaskCategory = (toolKey: string) => {
    if (starting || activeRunID !== null || state.kind !== 'ready' || toolKey === taskToolFilter) return;
    if (toolKey !== '' && !state.tasks.some((task) => taskToolKey(task) === toolKey)) return;
    setTaskToolFilter(toolKey);
    // When filtering from the shared task browser, keep the built-in CLI
    // top-bar selection and breadcrumbs aligned with the chosen tool.
    const platform = platforms.find((candidate) => taskToolKey(candidate) === toolKey);
    if (platform !== undefined) setSelectedPlatformID(platform.id);
    const first = state.tasks.find((task) => toolKey === '' || taskToolKey(task) === toolKey);
    if (first) selectTaskByKey(first.packId + '/' + first.commandId, state.tasks);
    setTaskChosen(false);
  };

  const openPlatformFeature = (feature: PlatformFeatureID) => {
    if (activePlatform === undefined) return;
    switch (feature) {
      case 'tasks':
        changeTaskCategory(taskToolKey(activePlatform));
        navigate('tasks');
        return;
      case 'sign-in':
        navigate('authentication');
        return;
      case 'security-audit':
        navigate('secret-audit');
        return;
      case 'access-explorer':
        navigate('access-explorer', 'conjur');
        return;
    }
  };


  const taskFilterLabel = state.kind === 'ready' && route === 'tasks' && taskToolFilter !== ''
    ? state.tasks.find((task) => taskToolKey(task) === taskToolFilter)
    : undefined;
  const taskFilterPlatform = taskFilterLabel === undefined ? undefined : platforms.find((platform) =>
    platform.packId === taskFilterLabel.packId && platform.toolId === taskFilterLabel.toolId);
  const breadcrumbPlatform = route === 'tasks' && taskFilterPlatform !== undefined ? taskFilterPlatform : activePlatform;
  const inDedicatedJourney = route === 'platform' || route === 'secret-audit' || route === 'access-explorer' ||
    (route === 'tasks' && taskFilterPlatform !== undefined);
  // An old dedicated deep link may be opened without a registered platform.
  // Keep the generic section selected rather than highlighting a broken target.
  const headerPlatform = inDedicatedJourney ? breadcrumbPlatform : undefined;
  const openPlatform = (platformID: string) => {
    setSelectedPlatformID(platformID);
    navigate('platform', platformID);
  };
  const navIcon = (path: string) => (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={path} /></svg>
  );
  const navLink = (item: (typeof navigationItems)[number]) => (
    <a key={item.route} href={routePaths[item.route]}
      aria-current={route === item.route ? 'page' : undefined}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        if (item.route === 'tasks') changeTaskCategory('');
        navigate(item.route);
      }}>
      {navIcon(item.icon)}
      <span>{item.label}</span>
      {item.route === 'runs' && activeRunID !== null && (
        <span className="nav-activity" aria-label="Task running">Live</span>
      )}
    </a>
  );

  // Built-in CLIs bring their own sign-in form and backend settings; custom CLIs use the generic card.
  const signInFor = (tool: ToolDiagnostic) => {
    const owner = platforms.find((platform) => platform.packId === tool.packId && platform.toolId === tool.toolId &&
      platform.features.some((feature) => feature.id === 'sign-in'));
    return owner === undefined ? undefined : dedicatedSignIn[owner.id];
  };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <aside id="workspace-navigation" className={'sidebar' + (navigationOpen ? ' sidebar--open' : '')}>
        <div className="brand-block">
          <svg className="brand-mark" aria-hidden="true" viewBox="0 0 32 32" fill="none">
            <path d="M13 6h6l1.5 18h-9z" fill="#1f86ea" />
            <path d="M12.6 11h6.8M12.2 16h7.6" stroke="#0a1020" strokeWidth="1.6" />
            <path d="M12 3.5h8V6h-8z" fill="#7cc4ff" />
            <path d="M16 1.5v2" stroke="#7cc4ff" strokeWidth="1.6" strokeLinecap="round" />
            <path d="M4 27.5c3 0 3-1.6 6-1.6s3 1.6 6 1.6 3-1.6 6-1.6 3 1.6 6 1.6" stroke="#3b9eff" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <h1>CLI<span>Harbor</span></h1>
        </div>
        <nav className="primary-nav" aria-label="Primary">
          <div className="nav-group" role="group" aria-labelledby="nav-label-workspace">
            <p className="nav-group-label">CLI workspace</p>
            <p className="nav-subgroup-label" id="nav-label-workspace">Work</p>
            {navigationItems.filter((item) => item.group === 'Workspace').map(navLink)}
          </div>
          <div className="nav-group" role="group" aria-labelledby="nav-label-manage">
            <p className="nav-subgroup-label" id="nav-label-manage">Set up &amp; manage</p>
            {navigationItems.filter((item) => item.group === 'Manage').map(navLink)}
          </div>
        </nav>
      </aside>
      <header className="topbar">
        <button type="button" className="secondary-button navigation-toggle" aria-controls="workspace-navigation" aria-expanded={navigationOpen}
          onClick={() => setNavigationOpen((open) => !open)}>Menu</button>
        <button type="button" className="quick-switch-trigger" disabled={!taskSwitcherAvailable}
          onClick={() => setTaskSwitcherOpen(true)} aria-haspopup="dialog" aria-keyshortcuts="Control+k Meta+k">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
            strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>
          </svg>
          <span className="visually-hidden">Find task</span>
          <span className="quick-switch-hint" aria-hidden="true">Search tasks, tools, and commands…</span>
          <kbd>Ctrl + K</kbd>
        </button>
        <nav className="section-switcher" aria-label="CLI sections">
          <a href={routePaths.platforms}
            aria-current={route === 'platforms' || headerPlatform !== undefined ? 'page' : undefined}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              navigate('platforms');
            }}>Built-in CLIs{headerPlatform && <span className="section-current"> · {headerPlatform.name}</span>}</a>
          <a href="/tools" aria-current={route === 'tools' ? 'page' : undefined} onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            navigate('tools');
          }}>Other CLIs</a>
        </nav>
        <div className="topbar-context">
          {state.kind === 'ready' && <OperationActivity tasks={state.tasks} onOpen={(path, runId, anchor) => {
            if (!navigate(routeFromPath(path), platformIDFromPath(path) || activePlatformID)) return;
            if (runId) setRequestedRun({ runId });
            else requestAnimationFrame(() => {
              const notice = anchor ? document.getElementById(anchor) : document.querySelector<HTMLElement>('.working-status:not(:empty)');
              const panel = notice?.closest('[role="tabpanel"][hidden]');
              const tabID = panel?.getAttribute('aria-labelledby');
              if (tabID) document.getElementById(tabID)?.click();
              notice?.scrollIntoView?.({ block: 'center' });
              notice?.focus();
            });
          }} />}
          {state.kind !== 'ready' && (
            <span className={'status-pill status-pill--' + (state.kind === 'loading' ? 'pending' : 'error')}>
              {state.kind === 'loading' ? 'Connecting…' : 'Connection unavailable'}
            </span>
          )}
          {state.kind === 'ready' && readyToolCount < state.tools.length && (
            <a className="status-pill status-pill--warn" href="/diagnostics" onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              navigate('diagnostics');
            }}>
              {state.tools.length - readyToolCount} CLI{state.tools.length - readyToolCount === 1 ? '' : 's'} need{state.tools.length - readyToolCount === 1 ? 's' : ''} attention
            </a>
          )}
          <a className="topbar-sign-in" href={routePaths.authentication}
            aria-current={route === 'authentication' ? 'page' : undefined}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              navigate('authentication');
            }}>
            {navIcon('M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4 M10 17l5-5-5-5 M15 12H3')}
            Sign in
          </a>
          {state.kind === 'ready' && (
            <CliSessionStatus tools={state.tools} tasks={state.tasks} checks={authenticationChecks} onCheckSession={(tool) => {
              if (!navigate('authentication')) return;
              quickCheckSequence.current += 1;
              setQuickCheck({ toolKey: tool.packId + '/' + tool.toolId, id: quickCheckSequence.current });
            }} onOpenSignIn={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              navigate('authentication');
            }} />
          )}
        </div>
      </header>

      {taskSwitcherOpen && state.kind === 'ready' && taskSwitcherAvailable && (
        <TaskSwitcher tasks={state.tasks} preferences={taskPreferences} onClose={() => setTaskSwitcherOpen(false)}
          onSelect={(key) => {
            setTaskSwitcherOpen(false);
            setTaskToolFilter('');
            focusConfigurationRef.current = true;
            selectTaskByKey(key, state.tasks);
            navigate('tasks');
          }} />
      )}

      <main ref={mainRef} id="main-content" tabIndex={-1} aria-busy={state.kind === 'loading'}>
        <nav className="breadcrumbs" aria-label="Breadcrumb">
          <a href={inDedicatedJourney ? routePaths.platforms : '/'}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              navigate(inDedicatedJourney ? 'platforms' : 'overview');
            }}>{inDedicatedJourney ? 'Built-in CLIs' : 'CLI workspace'}</a>
          {inDedicatedJourney && breadcrumbPlatform !== undefined && route !== 'platform' && (
            <>
              <span className="breadcrumb-divider" aria-hidden="true">/</span>
              <a href={pathForRoute('platform', breadcrumbPlatform.id)} onClick={(event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                navigate('platform', breadcrumbPlatform.id);
              }}>{breadcrumbPlatform.name}</a>
            </>
          )}
          <span className="breadcrumb-divider" aria-hidden="true">/</span>
          <span className="current-page" aria-current="page">{route === 'platform'
            ? breadcrumbPlatform?.name ?? 'Built-in CLI'
            : route === 'secret-audit' ? 'Security audit'
            : route === 'tasks' && taskFilterLabel !== undefined ? 'Command Builder · ' + taskFilterLabel.packName
            : navigationItems.find((item) => item.route === route)?.label}</span>
        </nav>
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
            signInFor={signInFor}
            checks={authenticationChecks}
            onCheckChange={recordAuthenticationCheck}
            quickCheck={quickCheck}
            onQuickCheckHandled={clearQuickCheck}
          />
        )}

        {state.kind === 'ready' && route === 'runs' && <RunsPage tasks={state.tasks} requestedRun={requestedRun} onOpenTasks={() => navigate('tasks')} />}

        {state.kind === 'ready' && route === 'access-explorer' && activePlatform?.id === 'conjur' && (
          <ConjurAccessExplorer
            tasks={state.tasks}
            csrfToken={state.status.csrfToken}
            onOpenSignIn={() => navigate('authentication')}
            onOpenDiagnostics={() => navigate('diagnostics')}
            onOpenTask={(commandId, prefill) => {
              if (starting || activeRunID !== null) return;
              const currentPlatform = platforms.find((p) => p.id === 'conjur');
              if (!currentPlatform) return;
              setTaskToolFilter(taskToolKey(currentPlatform));
              setSelectedPlatformID('conjur');
              focusConfigurationRef.current = true;
              selectTaskByKey(currentPlatform.packId + '/' + commandId, state.tasks, prefill);
              navigate('tasks', 'conjur');
            }}
          />
        )}
        {state.kind === 'ready' && route === 'secret-audit' && (
          <SecretAuditPage
            csrfToken={state.status.csrfToken}
            onOpenAuthentication={() => navigate('authentication')}
            onOpenDiagnostics={() => navigate('diagnostics')}
          />
        )}

        {state.kind === 'ready' && activePlatform === undefined && (route === 'platform' || route === 'access-explorer') && (
          <section className="panel" aria-labelledby="platform-heading">
            <p className="status-label">Dedicated CLI</p>
            <h2 id="platform-heading">No dedicated CLI is loaded</h2>
            <p>The generic workspace still works with every configured CLI.</p>
            <button type="button" className="secondary-button" onClick={() => navigate('platforms')}>Browse built-in CLIs</button>
          </section>
        )}

        {state.kind === 'ready' && route === 'platforms' && (
          <PlatformsPage platforms={platforms} tasks={state.tasks} onOpenPlatform={openPlatform}
            onOpenTools={() => navigate('tools')} />
        )}

        {state.kind === 'ready' && route === 'platform' && (activePlatform !== undefined ? (
          <PlatformPage
            platform={activePlatform}
            tasks={state.tasks}
            tools={state.tools}
            csrfToken={state.status.csrfToken}
            onOpenRuns={() => navigate('runs')}
            onOpenFeature={openPlatformFeature}
            onOpenDiagnostics={() => navigate('diagnostics')}
            onOpenTask={(key, prefill) => {
              if (starting || activeRunID !== null) return;
              setTaskToolFilter(taskToolKey(activePlatform));
              setSelectedPlatformID(activePlatform.id);
              focusConfigurationRef.current = true;
              selectTaskByKey(key, state.tasks, prefill);
              navigate('tasks', activePlatform.id);
            }}
          />
        ) : null)}

        {state.kind === 'ready' && route === 'overview' && (
          <OverviewPage
            tasks={state.tasks}
            tools={state.tools}
            preferences={taskPreferences}
            onNavigate={navigate}
            onOpenTask={(taskKey) => {
              setTaskToolFilter('');
              selectTaskByKey(taskKey, state.tasks);
              navigate('tasks');
            }}
          />
        )}

        {state.kind === 'ready' && (route === 'tools' || route === 'diagnostics') && (
          <>
            <section className="runtime-overview" aria-labelledby="runtime-heading">
              <div className="runtime-copy">
                <p className="runtime-state">Local CLI workspace</p>
                <h2 id="runtime-heading">{route === 'tools' ? 'Add a command-line tool' : 'Check your tools'}</h2>
                <p>
                  {route === 'tools' ? 'Install an approved CLI or create a reviewable custom pack draft.' : 'See what is ready, what needs attention, and where to fix it.'}
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
            <ToolsPage tools={state.tools} tasks={state.tasks} catalog={route === 'tools'}
              installingKey={installingToolKey} notice={toolInstallNotice} installRoots={toolInstallRoots}
              refreshingKey={refreshingToolKey} onRefresh={(tool) => void refreshMissingCLI(tool)}
              tasksLocked={starting || activeRunID !== null || Object.keys(local).length > 0}
              onInstall={(tool) => void installManagedCLI(tool)}
              onInstallRoot={(key, value) => setToolInstallRoots((current) => ({ ...current, [key]: value }))}
              onOpenTasks={(key) => { changeTaskCategory(key); navigate('tasks'); }}
              onOpenAuthentication={() => navigate('authentication')} />
          </>
        )}

        {state.kind === 'ready' && route === 'tasks' && (
          <div className="builder-layout">
            <ToolExplorer tools={state.tools} tasks={state.tasks} selectedToolKey={taskToolFilter}
              disabled={starting || activeRunID !== null}
              onSelectTool={changeTaskCategory} onOpenTools={() => navigate('tools')} />

            <div className="builder-main">
              <header className="page-header">
                <div>
                  <h2>Command Builder</h2>
                  <p>Configure, validate, and preview a command before execution.</p>
                </div>
                <p className="page-header-shortcuts"><kbd>/</kbd> search tasks <kbd>Ctrl K</kbd> find anywhere</p>
              </header>
              {taskFilterLabel !== undefined && (
                <div className="task-scope-banner" role="status">
                  <div>
                    <strong>Showing {taskFilterLabel.packName} tasks</strong>
                    <p>Only tasks from {taskFilterLabel.packName} · {taskFilterLabel.toolId} are listed. You are still using the shared task runner.</p>
                  </div>
                  <button type="button" className="secondary-button" disabled={starting || activeRunID !== null}
                    onClick={() => changeTaskCategory('')}>Show all CLIs</button>
                </div>
              )}
              <article className="panel builder-card" aria-label="Command configuration">
                {state.tasks.length === 0 ? (
                  <div className="empty-state">
                    <strong>No safe tasks are available.</strong>
                    <p>Add a supported CLI to populate your workspace with approved tasks.</p>
                    <button type="button" onClick={() => navigate('tools')}>Add a CLI</button>
                  </div>
                ) : (
                  <form ref={taskFormRef} onSubmit={startRun} noValidate>
                    <section className="builder-step" aria-labelledby="builder-step-select">
                      <h3 id="builder-step-select" className="builder-step-heading">
                        <span className="step-badge" aria-hidden="true">1</span>Select tool and command
                      </h3>
                      <TaskDiscovery
                        tasks={state.tasks}
                        selectedTaskKey={selectedTaskKey}
                        preferences={taskPreferences}
                        collapsed={taskChosen}
                        toolFilter={taskToolFilter}
                        onFilterChange={changeTaskCategory}
                        disabled={starting || activeRunID !== null}
                        onSelect={(key) => {
                          focusConfigurationRef.current = true;
                          selectTaskByKey(key, state.tasks);
                        }}
                        onToggleFavorite={(task) =>
                          updateTaskPreferences((current) => toggleFavoriteTask(current, task))
                        }
                      />
                    </section>

                    {selectedTask !== undefined && (
                      <>
                        <section className="builder-step" aria-labelledby="builder-step-configure">
                          <h3 id="builder-step-configure" className="builder-step-heading">
                            <span className="step-badge" aria-hidden="true">2</span>Configure parameters
                          </h3>
                          <div className="task-context">
                            <div className="task-context-header">
                              <h4 ref={configurationHeadingRef} tabIndex={-1}>{selectedTask.name}</h4>
                              <span className={"safety-chip safety-chip--" + selectedTask.risk}>
                                {selectedTask.risk === 'read'
                                  ? 'Read-only safe task'
                                  : selectedTask.risk === 'change'
                                    ? 'Change task · approval required'
                                    : 'Destructive task · approval required'}
                              </span>
                            </div>
                            {selectedTask.description && <p>{selectedTask.description}</p>}
                            {selectedTask.impact && (
                              <div
                                className={"task-impact-warning task-impact-warning--" + selectedTask.risk}
                                role={selectedTask.risk === 'destructive' ? 'alert' : 'note'}
                              >
                                <strong>
                                  {selectedTask.risk === 'destructive' ? 'High-impact destructive operation' : 'This task changes vendor state'}
                                </strong>
                                <p>{selectedTask.impact.effect}</p>
                                <p>
                                  Scope: {selectedTask.impact.scope === 'multiple'
                                    ? 'may change multiple records or access relationships; explicit typed approval is required'
                                    : 'one declared target; explicit approval is required'}.
                                </p>
                              </div>
                            )}
                            {selectedTask.requiresAuth && (
                              <div className="task-auth-callout">
                                <span>This task requires sign-in. CLIHarbor will not assume an installed tool is already authenticated.</span>
                                <button type="button" className="secondary-button" onClick={() => navigate('authentication')}>
                                  Review {selectedTask.toolId} sign-in
                                </button>
                              </div>
                            )}
                          </div>
                          {selectedTask.inputs.length === 0 && <p className="builder-no-inputs">This task has no inputs. Run it when you are ready.</p>}
                          <fieldset className="form-stack builder-fields" disabled={starting || activeRunID !== null}>
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
                                  setApprovalConfirmation('');
                                  setPreviewing(false);
                                  if (taskFailure?.field === `values.${input.id}`) {
                                    setTaskFailure(null);
                                  }
                                }}
                              />
                            ))}
                          </fieldset>
                          <details className="technical-details task-technical-details">
                            <summary>Technical task details</summary>
                            <p>
                              Pack: {selectedTask.packName} ({selectedTask.packId}) · Tool: {selectedTask.toolId}
                              {selectedTask.toolVersion ? ' ' + selectedTask.toolVersion : ''} · Command: {selectedTask.commandId}
                            </p>
                            <p>Executable and argument authority stay on the authenticated local runtime.</p>
                          </details>
                        </section>

                        <section className="builder-step command-preview" aria-labelledby="builder-step-preview" aria-live="polite" aria-busy={previewing}>
                          <div className="builder-step-heading-row">
                            <h3 id="builder-step-preview" className="builder-step-heading">
                              <span className="step-badge" aria-hidden="true">3</span>Command preview
                            </h3>
                            <span className={'command-preview-state' + (commandPreview === null ? '' : ' command-preview-state--valid')}>
                              {commandPreview === null ? 'Not validated' : 'Validated by local runtime'}
                            </span>
                          </div>
                          <div className="command-line">
                            <span className="command-line-number" aria-hidden="true">1</span>
                            {commandPreview === null ? (
                              <span className="command-line-placeholder">
                                {mutationTask
                                  ? 'Review the change to see the exact command and approval checkpoint.'
                                  : 'Validate to see the exact command CLIHarbor will run.'}
                              </span>
                            ) : (
                              <code className="invocation-preview">
                                {[commandPreview.executableName, ...commandPreview.args].map((token, index, tokens) => (
                                  <span key={index} className={'token token--' + (index === 0 ? 'executable'
                                    : token.startsWith('-') ? 'flag'
                                    : tokens.slice(1, index).some((previous) => previous.startsWith('-')) ? 'value' : 'command')}>
                                    {(index === 0 ? '' : ' ') + formatInvocationToken(token)}
                                  </span>
                                ))}
                              </code>
                            )}
                          </div>
                          {commandPreview !== null && (
                            <>
                              <p className="preview-note">
                                Display only. CLIHarbor executes the trusted executable path and argv directly; this text is never reparsed.
                              </p>
                              {commandPreview.impact && commandPreview.context && commandPreview.approval && (
                                <section className="mutation-approval" aria-labelledby="mutation-approval-heading">
                                  <div className="mutation-approval-heading">
                                    <span className="status-label">Approval checkpoint</span>
                                    <strong id="mutation-approval-heading">
                                      Verify the exact target and environment
                                    </strong>
                                  </div>
                                  <dl className="mutation-review">
                                    <div>
                                      <dt>{commandPreview.impact.targetLabel}</dt>
                                      <dd>{commandPreview.impact.target}</dd>
                                    </div>
                                    <div>
                                      <dt>Effect</dt>
                                      <dd>{commandPreview.impact.effect}</dd>
                                    </div>
                                    <div>
                                      <dt>Scope</dt>
                                      <dd>{commandPreview.impact.scope === 'multiple' ? 'Multiple records / relationships' : 'Single declared target'}</dd>
                                    </div>
                                    {commandPreview.stdin !== undefined && (
                                      <div>
                                        <dt>Policy sent to the CLI</dt>
                                        <dd>
                                          <pre className="mutation-stdin">{commandPreview.stdin}</pre>
                                        </dd>
                                      </div>
                                    )}
                                    {selectedTask.inputs.some((input) => input.type === 'secret') && (
                                      <div>
                                        <dt>Secret value</dt>
                                        <dd>Sent to the CLI on standard input only. It is not shown here or kept in run history.</dd>
                                      </div>
                                    )}
                                    {commandPreview.context.fields.map((field) => (
                                      <div key={field.label}>
                                        <dt>{field.label}</dt>
                                        <dd>{field.value}</dd>
                                      </div>
                                    ))}
                                  </dl>
                                  {commandPreview.approval.mode === 'typed' ? (
                                    <label className="typed-approval">
                                      <span>Type this exactly to approve:</span>
                                      <code>{commandPreview.approval.requiredText}</code>
                                      <input
                                        type="text"
                                        autoComplete="off"
                                        spellCheck={false}
                                        value={approvalConfirmation}
                                        onChange={(event) => setApprovalConfirmation(event.target.value)}
                                        disabled={starting || activeRunID !== null}
                                        aria-label="Typed approval"
                                      />
                                    </label>
                                  ) : (
                                    <p className="approval-note">
                                      Selecting Approve and run below is the explicit approval for this exact reviewed plan.
                                    </p>
                                  )}
                                  <p className="approval-expiry">
                                    Approval is short-lived, single-use, and bound by the backend to this exact command, target, inputs, executable, and environment context.
                                  </p>
                                </section>
                              )}
                            </>
                          )}
                        </section>

                        {mutationTask && <ExecutionContext fields={commandPreview?.context?.fields ?? (activeRunID ? run?.context?.fields : undefined) ?? [{ label: 'Environment', value: 'Review the change to verify the backend context.' }]}
                          target={commandPreview?.impact?.target ?? (activeRunID ? run?.target : undefined)} />}
                        <div className="task-actions">
                          <button
                            type="button"
                            className="secondary-button"
                            disabled={commandPreview === null}
                            onClick={() => {
                              if (commandPreview === null) return;
                              const copied = commandPreview;
                              const write = navigator.clipboard?.writeText(formatInvocation(copied)) ?? Promise.reject(new Error('clipboard unavailable'));
                              void write.then(
                                () => setCopyResult({ preview: copied, copied: true }),
                                () => setCopyResult({ preview: copied, copied: false }),
                              );
                            }}
                          >
                            {copyResult === null || copyResult.preview !== commandPreview ? 'Copy command' : copyResult.copied ? 'Copied' : 'Copy failed'}
                          </button>
                          <span className="visually-hidden" role="status">
                            {copyResult === null || copyResult.preview !== commandPreview
                              ? ''
                              : copyResult.copied ? 'Command copied' : 'Clipboard unavailable. Select the command preview to copy it manually.'}
                          </span>
                          <button
                            type="button"
                            className="secondary-button"
                            disabled={starting || activeRunID !== null || JSON.stringify(formValues) === JSON.stringify(initialValues(selectedTask))}
                            onClick={() => selectTaskByKey(selectedTask.packId + '/' + selectedTask.commandId, state.tasks)}
                          >
                            Reset inputs
                          </button>
                          <button
                            type="button"
                            className="validate-button"
                            aria-busy={previewing}
                            disabled={previewing || starting || activeRunID !== null}
                            onClick={() => void previewSelectedTask()}
                          >
                            {previewing
                              ? 'Checking…'
                              : mutationTask
                                ? selectedTask.risk === 'destructive'
                                  ? 'Review destructive change'
                                  : 'Review change'
                                : 'Validate'}
                          </button>
                          <button
                            type="submit"
                            className="run-button"
                            aria-busy={starting || activeRunID !== null}
                            disabled={previewing || starting || activeRunID !== null || (mutationTask && !mutationApprovalReady)}
                          >
                            {starting
                              ? 'Starting…'
                              : activeRunID !== null
                                ? 'Running…'
                              : mutationTask
                                ? selectedTask.risk === 'destructive'
                                  ? 'Approve destructive change and run'
                                  : 'Approve change and run'
                                : 'Run command'}
                          </button>
                        </div>
                      </>
                    )}
                  </form>
                )}
                <WorkingStatus active={previewing || starting || activeRunID !== null}
                  id="command-work-progress"
                  track={!starting && activeRunID === null}
                  mutation={starting ? selectedTask?.risk !== 'read' : activeRunID !== null && runTask?.risk !== 'read'}
                  title={previewing ? 'Validating command…' : starting ? 'Starting command…' : cancelRequested ? 'Stopping command…' : 'Command running…'}
                  detail={activeRunID !== null ? 'Follow progress in Output or Execution History. This command is already running.' : undefined} />
                {taskFailure && !taskHasFieldFailure && (
                  <div ref={taskErrorRef} tabIndex={-1}>
                    <FailureNotice
                      title={taskFailure.category === 'validation' ? 'Task inputs need attention' : mutationTask ? 'Change request needs review' : 'Task could not start'}
                      failure={taskFailure}
                    />
                    {mutationTask && taskFailure.category !== 'validation' && <p>A failed response alone does not prove that nothing changed. Inspect Execution History and the target before requesting another approval.</p>}
                    {mutationTask && <button type="button" className="secondary-button" onClick={() => navigate('runs')}>Inspect Execution History</button>}
                  </div>
                )}
              </article>
            </div>

            <ExecutionPreflight
              task={selectedTask}
              tool={selectedTask === undefined ? undefined : state.tools.find((tool) => taskToolKey(tool) === taskToolKey(selectedTask))}
              validated={commandPreview !== null}
              validating={previewing}
              validationFailed={taskFailure?.category === 'validation'}
              approvalReady={mutationApprovalReady}
            />

            <section className={"panel run-panel" + (run !== null ? " run-panel--engaged" : "")} aria-labelledby="run-heading">
              <div className="output-tabs" role="tablist" aria-label="Result views" onKeyDown={(event) => {
                if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
                event.preventDefault();
                const next = outputTab === 'output' ? 'activity' : 'output';
                setOutputTab(next);
                document.getElementById('output-tab-' + next)?.focus();
              }}>
                {(['output', 'activity'] as const).map((tab) => (
                  <button key={tab} type="button" role="tab" id={'output-tab-' + tab} aria-controls={'output-tabpanel-' + tab}
                    aria-selected={outputTab === tab} tabIndex={outputTab === tab ? 0 : -1} onClick={() => setOutputTab(tab)}>
                    {tab === 'output' ? 'Output' : 'Activity log'}
                    {tab === 'activity' && activity.length > 0 && <span className="output-tab-count">{activity.length}</span>}
                  </button>
                ))}
              </div>
              <div role="tabpanel" id="output-tabpanel-output" aria-labelledby="output-tab-output" hidden={outputTab !== 'output'}>
                <div className={"run-state run-state--" + (run === null ? "idle" : run.retained ? runOutcomeTone(run.snapshot.status, run.snapshot.exitCode) : "unavailable")} role="status" aria-live="polite" aria-atomic="true">
                  <h2 ref={resultHeadingRef} id="run-heading" tabIndex={-1}>{run === null ? 'No active run' : run.retained ? runOutcomeHeading(run.snapshot.status, run.snapshot.exitCode) : 'Run no longer retained'}</h2>
                  <p>{run === null ? 'Start a safe task to stream its output here.' : runStatusDescription(run, cancelRequested)}</p>
                </div>
                {run !== null && (
                  <>
                    {run.context && <ExecutionContext fields={run.context.fields} target={run.target} />}
                    {run.retained && run.snapshot.status !== 'running' && <OperationResult result={{
                      title: run.snapshot.status === 'exited' && run.snapshot.exitCode === 0 ? 'Command completed successfully' : 'Command outcome needs review',
                      tone: run.snapshot.status === 'exited' && run.snapshot.exitCode === 0 ? 'success' : 'warning',
                      steps: [{ label: runTask?.name ?? run.snapshot.commandId, state: run.snapshot.status === 'exited' && run.snapshot.exitCode === 0 ? 'done' : 'unknown' }],
                      next: runTask?.risk !== 'read' && !(run.snapshot.status === 'exited' && run.snapshot.exitCode === 0)
                        ? 'A change may have occurred. Inspect execution evidence and the target before deciding whether another change is needed.'
                        : 'Review the output and execution evidence before your next command.',
                    }}><button type="button" className="secondary-button" onClick={() => { if (navigate('runs')) setRequestedRun({ runId: run.snapshot.runId }); }}>Open Execution History</button></OperationResult>}
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
                            {starting
                              ? 'Starting…'
                              : runTask?.risk !== undefined && runTask.risk !== 'read'
                                ? 'Review before retry'
                                : 'Retry with inputs'}
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
                          <span>This task requires a vendor session and failed. Check this CLI's session before retrying; the failure alone does not prove sign-out.</span>
                          <button type="button" className="secondary-button" onClick={() => {
                            if (runTask !== undefined) navigate('authentication');
                          }}>
                            Review {runTask?.toolId ?? 'CLI'} sign-in
                          </button>
                        </div>
                      )}
                    {run.snapshot.structured && <h3 className="structured-result-heading">Structured result</h3>}
                    {run.snapshot.structured?.status === 'invalid' && (
                      <p className="parser-warning" role="status">
                        {structuredFailureMessage(run.snapshot.structured.error)}
                        {run.snapshot.structured.error && <> Parser code: <code>{run.snapshot.structured.error}</code>.</>}
                        {' '}Raw output remains available.
                      </p>
                    )}
                    <OutputExplorer key={run.snapshot.runId}
                      stdout={output.stdout} stderr={output.stderr}
                      status={run.snapshot.status} exitCode={run.snapshot.exitCode} structured={run.snapshot.structured}
                      rawOutput={<div className="output-grid">
                        <OutputStream name="stdout" text={output.stdout} live={run.snapshot.status === 'running'} />
                        <OutputStream name="stderr" text={output.stderr} live={run.snapshot.status === 'running'} />
                      </div>} />
                  </>
                )}
              </div>
              <div role="tabpanel" id="output-tabpanel-activity" aria-labelledby="output-tab-activity" hidden={outputTab !== 'activity'}>
                {activity.length === 0 ? (
                  <p className="activity-empty">No activity yet. Validate or run a task to record its lifecycle here.</p>
                ) : (
                  <>
                    <ol className="activity-log">
                      {activity.map((entry) => (
                        <li key={entry.id}>
                          <time dateTime={entry.at.toISOString()}>[{formatActivityTime(entry.at)}]</time>
                          <span className={'activity-level activity-level--' + entry.level.toLowerCase()}>[{entry.level}]</span>
                          <span className="activity-message">{entry.message}</span>
                          {entry.tag && <span className={'activity-tag activity-tag--' + (entry.tone ?? 'pending')}>{entry.tag}</span>}
                        </li>
                      ))}
                    </ol>
                    <button type="button" className="secondary-button activity-clear" onClick={() => setActivity([])}>Clear activity log</button>
                  </>
                )}
              </div>
            </section>
          </div>
        )}
      </main>

      <footer>
        <p>Local runtime · No cloud backend · No telemetry by default · No remote runtime assets</p>
      </footer>
    </div>
  );
}

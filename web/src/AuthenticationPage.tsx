import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { normalizeError, type AppErrorDetail } from './api/errors';
import type { RuntimeStatus } from './api/status';
import type { Task } from './api/tasks';
import type { ToolDiagnostic } from './api/tools';
import { describeToolReadiness } from './operatorLanguage';
import { ToolIcon } from './ToolIcon';
import {
  cancelRun,
  createRun,
  decodeBase64Text,
  fetchRun,
  subscribeRunEvents,
  type RunComplete,
  type RunEvent,
  type RunSnapshot,
} from './api/runs';

const maxAuthEvidenceChars = 64 * 1024;

interface SafeIdentity {
  account?: string;
  username?: string;
  user?: string;
}

export type AuthenticationCheck =
  | { kind: 'unchecked' }
  | { kind: 'checking'; runId?: string }
  | { kind: 'authenticated'; checkedAt: string; identity: SafeIdentity }
  | { kind: 'required'; checkedAt: string }
  | { kind: 'cancelled'; checkedAt: string }
  | { kind: 'failed'; checkedAt: string; failure: AppErrorDetail | AuthCheckFailure };

interface AuthCheckFailure {
  message: string;
  remediation: string;
}

/** What a sign-in provider gets from the generic session card it renders inside. */
export interface SignInContext {
  status: RuntimeStatus;
  tool: ToolDiagnostic;
  headingID: string;
  ready: boolean;
  checkKind: AuthenticationCheck['kind'];
  /** Runs the pack-declared session check; resolves when the check settles or fails to start. */
  verifySession: () => Promise<void>;
  onToolsChanged?: () => void;
  /** Clear previous session evidence after changing the vendor API connection. */
  invalidateSession?: () => void;
  /** Open this CLI's settings panel, e.g. when a backend must be configured first. */
  openSettings: () => void;
  settingsOpen: boolean;
}

/**
 * A dedicated platform's sign-in flow for one tool. The universal page owns the
 * session check; the provider owns the vendor sign-in form and backend settings.
 */
export interface ToolSignIn {
  render: (context: SignInContext) => ReactNode;
  /** Backend/connection settings shown behind the card's settings button. */
  settings?: (context: SignInContext) => ReactNode;
  /** Sign-in cannot start until settings are configured; opens settings on load. */
  needsSetup?: (tool: ToolDiagnostic) => boolean;
  signedOutDetail?: (tool: ToolDiagnostic) => string | undefined;
}

interface AuthenticationPageProps {
  status: RuntimeStatus;
  tasks: Task[];
  tools: ToolDiagnostic[];
  onOpenTasks: () => void;
  onOpenDiagnostics: () => void;
  onToolsChanged?: () => void;
  /** Dedicated sign-in provider for a tool, when a built-in platform owns it. */
  signInFor?: (tool: ToolDiagnostic) => ToolSignIn | undefined;
}

interface VendorSessionCardProps {
  status: RuntimeStatus;
  tasks: Task[];
  tool: ToolDiagnostic;
  onOpenTasks: () => void;
  onOpenDiagnostics: () => void;
  onToolsChanged?: () => void;
  signIn?: ToolSignIn;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function safeIdentityText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const text = value.trim();
  if (text.length === 0 || text.length > 256) {
    return undefined;
  }
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) {
      return undefined;
    }
  }
  return text;
}

function parseSafeIdentity(stdout: string): SafeIdentity {
  if (stdout.length === 0 || stdout.length > maxAuthEvidenceChars) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!isRecord(parsed)) {
      return {};
    }
    return {
      account: safeIdentityText(parsed.account),
      username: safeIdentityText(parsed.username),
      user: safeIdentityText(parsed.user),
    };
  } catch {
    return {};
  }
}

function appendBounded(current: string, next: string): string {
  if (current.length >= maxAuthEvidenceChars || next.length === 0) {
    return current;
  }
  return current + next.slice(0, maxAuthEvidenceChars - current.length);
}

function failureFromRun(
  status: RunSnapshot['status'],
  label: string,
  failure?: AppErrorDetail,
): AuthCheckFailure | AppErrorDetail {
  if (failure !== undefined) {
    return failure;
  }
  switch (status) {
    case 'timed-out':
      return {
        message: label + ' session check timed out.',
        remediation: 'Retry the check. If it continues to time out, open Diagnostics and verify the local vendor/runtime path.',
      };
    case 'cancelled':
      return {
        message: label + ' session check was cancelled.',
        remediation: 'Select Re-check session when you are ready to verify the vendor session.',
      };
    case 'failed':
      return {
        message: 'CLIHarbor could not complete the ' + label + ' session check.',
        remediation: 'Open Diagnostics for sanitized local readiness information, then retry.',
      };
    default:
      return {
        message: label + ' did not confirm an authenticated session.',
        remediation:
          'Authenticate using your organization’s approved vendor-owned CLI process, then return here and re-check the session. If you are already signed in, open Diagnostics.',
      };
  }
}

function evidenceFromSnapshot(
  snapshot: RunSnapshot,
  stdoutRef: { current: string },
  stderrRef: { current: string },
  decoders: { current: { stdout: TextDecoder; stderr: TextDecoder } },
): void {
  stdoutRef.current = '';
  stderrRef.current = '';
  decoders.current = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  for (const event of snapshot.events ?? []) {
    if (event.dataBase64 === undefined) {
      continue;
    }
    if (event.type === 'stdout.chunk') {
      stdoutRef.current = appendBounded(stdoutRef.current, decodeBase64Text(event.dataBase64, decoders.current.stdout, true));
    } else if (event.type === 'stderr.chunk') {
      stderrRef.current = appendBounded(stderrRef.current, decodeBase64Text(event.dataBase64, decoders.current.stderr, true));
    }
  }
}

function VendorSessionCard({
  status,
  tasks,
  tool,
  onOpenTasks,
  onOpenDiagnostics,
  onToolsChanged,
  signIn,
}: VendorSessionCardProps) {
  const [check, setCheck] = useState<AuthenticationCheck>({ kind: 'unchecked' });
  const [settingsOpen, setSettingsOpen] = useState(() => signIn?.needsSetup?.(tool) === true);
  const attemptRef = useRef(0);
  const activeRunRef = useRef<string | null>(null);
  const closeStreamRef = useRef<(() => void) | null>(null);
  const stdoutRef = useRef('');
  const stderrRef = useRef('');
  const decodersRef = useRef({ stdout: new TextDecoder(), stderr: new TextDecoder() });

  const sessionTask = useMemo(() => {
    if (tool.sessionCheck === undefined) {
      return undefined;
    }
    return tasks.find(
      (task) =>
        task.packId === tool.packId &&
        task.toolId === tool.toolId &&
        task.commandId === tool.sessionCheck?.commandId &&
        task.requiresAuth === true &&
        task.inputs.length === 0,
    );
  }, [tasks, tool]);

  const toolView = describeToolReadiness(tool);
  const canCheck = toolView.ready && tool.sessionCheck !== undefined && sessionTask !== undefined;
  const showDiagnostics =
    !toolView.ready ||
    (tool.sessionCheck !== undefined && sessionTask === undefined) ||
    check.kind === 'failed';
  const label = tool.packName || tool.toolId;
  const headingID = 'vendor-session-' + tool.packId + '-' + tool.toolId;

  useEffect(
    () => () => {
      attemptRef.current += 1;
      closeStreamRef.current?.();
      closeStreamRef.current = null;
      activeRunRef.current = null;
    },
    [],
  );

  const finishAttempt = (
    attempt: number,
    runStatus: RunSnapshot['status'],
    exitCode: number | undefined,
    failure?: AppErrorDetail,
  ) => {
    if (attempt !== attemptRef.current) {
      return;
    }
    closeStreamRef.current?.();
    closeStreamRef.current = null;
    activeRunRef.current = null;
    stdoutRef.current = appendBounded(stdoutRef.current, decodersRef.current.stdout.decode());
    stderrRef.current = appendBounded(stderrRef.current, decodersRef.current.stderr.decode());
    const checkedAt = new Date().toISOString();

    if (runStatus === 'exited' && exitCode === 0) {
      setCheck({
        kind: 'authenticated',
        checkedAt,
        identity: parseSafeIdentity(stdoutRef.current),
      });
      return;
    }

    const signedOutEvidence = tool.sessionCheck?.unauthenticatedStderrContains;
    if (
      runStatus === 'exited' &&
      signedOutEvidence !== undefined &&
      stderrRef.current.toLowerCase().includes(signedOutEvidence.toLowerCase())
    ) {
      setCheck({ kind: 'required', checkedAt });
      return;
    }

    if (runStatus === 'cancelled') {
      setCheck({ kind: 'cancelled', checkedAt });
      return;
    }

    setCheck({
      kind: 'failed',
      checkedAt,
      failure: failureFromRun(runStatus, label, failure),
    });
  };

  const recordEvent = (attempt: number, event: RunEvent) => {
    if (attempt !== attemptRef.current || event.runId !== activeRunRef.current || event.dataBase64 === undefined) {
      return;
    }
    if (event.type === 'stdout.chunk') {
      stdoutRef.current = appendBounded(stdoutRef.current, decodeBase64Text(event.dataBase64, decodersRef.current.stdout, true));
    } else if (event.type === 'stderr.chunk') {
      stderrRef.current = appendBounded(stderrRef.current, decodeBase64Text(event.dataBase64, decodersRef.current.stderr, true));
    }
  };

  const reconcileAfterStreamFailure = (attempt: number, runId: string, streamFailure: AppErrorDetail) => {
    void fetchRun(runId).then(
      (snapshot) => {
        if (attempt !== attemptRef.current) {
          return;
        }
        try {
          evidenceFromSnapshot(snapshot, stdoutRef, stderrRef, decodersRef);
        } catch (error) {
          closeStreamRef.current?.();
          closeStreamRef.current = null;
          activeRunRef.current = null;
          setCheck({
            kind: 'failed',
            checkedAt: new Date().toISOString(),
            failure: normalizeError(error, 'invalid_response').detail,
          });
          return;
        }
        if (snapshot.status !== 'running') {
          finishAttempt(attempt, snapshot.status, snapshot.exitCode, snapshot.failure);
          return;
        }

        closeStreamRef.current?.();
        closeStreamRef.current = null;
        activeRunRef.current = null;
        void cancelRun(status.csrfToken, runId).catch(() => undefined);
        setCheck({
          kind: 'failed',
          checkedAt: new Date().toISOString(),
          failure: {
            message: 'Live updates ended before CLIHarbor could verify the ' + label + ' session.',
            remediation: streamFailure.remediation || 'Retry the session check from this page.',
          },
        });
      },
      (error: unknown) => {
        if (attempt !== attemptRef.current) {
          return;
        }
        activeRunRef.current = null;
        setCheck({
          kind: 'failed',
          checkedAt: new Date().toISOString(),
          failure: normalizeError(error).detail,
        });
      },
    );
  };

  const startCheck = async () => {
    if (!canCheck || check.kind === 'checking' || sessionTask === undefined) {
      return;
    }

    const attempt = attemptRef.current + 1;
    attemptRef.current = attempt;
    closeStreamRef.current?.();
    closeStreamRef.current = null;
    activeRunRef.current = null;
    stdoutRef.current = '';
    stderrRef.current = '';
    // A cancelled/lost stream may leave incomplete UTF-8 in the old decoder.
    // Never let one vendor session check influence the next attempt.
    decodersRef.current = { stdout: new TextDecoder(), stderr: new TextDecoder() };
    setCheck({ kind: 'checking' });

    try {
      const snapshot = await createRun(status.csrfToken, {
        packId: sessionTask.packId,
        commandId: sessionTask.commandId,
        values: {},
      });
      if (attempt !== attemptRef.current) {
        return;
      }

      activeRunRef.current = snapshot.runId;
      evidenceFromSnapshot(snapshot, stdoutRef, stderrRef, decodersRef);

      if (snapshot.status !== 'running') {
        finishAttempt(attempt, snapshot.status, snapshot.exitCode, snapshot.failure);
        return;
      }

      setCheck({ kind: 'checking', runId: snapshot.runId });
      closeStreamRef.current = subscribeRunEvents(
        snapshot.runId,
        (event) => recordEvent(attempt, event),
        (complete: RunComplete) => {
          finishAttempt(attempt, complete.status, complete.exitCode, complete.failure);
        },
        (error) => {
          if (attempt !== attemptRef.current) {
            return;
          }
          reconcileAfterStreamFailure(attempt, snapshot.runId, error.detail);
        },
        undefined,
        snapshot.events?.at(-1)?.sequence ?? 0,
      );
    } catch (error) {
      if (attempt !== attemptRef.current) {
        return;
      }
      activeRunRef.current = null;
      closeStreamRef.current?.();
      closeStreamRef.current = null;
      setCheck({
        kind: 'failed',
        checkedAt: new Date().toISOString(),
        failure: normalizeError(error).detail,
      });
    }
  };

  const cancelCheck = async () => {
    if (check.kind !== 'checking' || check.runId === undefined || activeRunRef.current !== check.runId) {
      return;
    }
    const runId = check.runId;
    const cancellationAttempt = attemptRef.current + 1;
    attemptRef.current = cancellationAttempt;
    closeStreamRef.current?.();
    closeStreamRef.current = null;
    activeRunRef.current = null;
    try {
      await cancelRun(status.csrfToken, runId);
      if (attemptRef.current !== cancellationAttempt) {
        return;
      }
      setCheck({ kind: 'cancelled', checkedAt: new Date().toISOString() });
    } catch (error) {
      if (attemptRef.current !== cancellationAttempt) {
        return;
      }
      setCheck({
        kind: 'failed',
        checkedAt: new Date().toISOString(),
        failure: normalizeError(error).detail,
      });
    }
  };

  let primaryHeading = 'Authentication not verified';
  let primaryDetail =
    'Check this tool’s session to see whether you are signed in.';
  let primaryClass = 'auth-state--neutral';
  let primarySymbol = '?';

  if (!toolView.ready) {
    primaryHeading = 'Tool unavailable';
    primaryDetail = 'CLIHarbor cannot check this vendor session until the reviewed CLI is ready.';
    primaryClass = 'auth-state--attention';
    primarySymbol = '!';
  } else if (tool.sessionCheck === undefined) {
    primaryHeading = 'Session check unavailable';
    primaryDetail =
      'This trusted pack uses vendor-session workflows but does not declare a reviewed non-secret session check. CLIHarbor will not guess from arbitrary vendor commands or errors.';
    primaryClass = 'auth-state--neutral';
    primarySymbol = '–';
  } else if (sessionTask === undefined) {
    primaryHeading = 'Authentication check unavailable';
    primaryDetail =
      'The trusted runtime did not expose the pack-declared session-check command. Open Diagnostics before continuing.';
    primaryClass = 'auth-state--attention';
    primarySymbol = '!';
  } else if (check.kind === 'checking') {
    primaryHeading = 'Checking session';
    primaryDetail =
      'CLIHarbor is running the pack-declared read-only session check through the normal trusted execution path.';
    primaryClass = 'auth-state--checking';
    primarySymbol = '…';
  } else if (check.kind === 'authenticated') {
    primaryHeading = 'Authenticated';
    primaryDetail = 'The reviewed session-check workflow completed successfully using the vendor-owned session.';
    primaryClass = 'auth-state--authenticated';
    primarySymbol = '✓';
  } else if (check.kind === 'required') {
    primaryHeading = 'Authentication required';
    primaryDetail =
      signIn?.signedOutDetail?.(tool) ??
      'The reviewed session check returned the pack-declared signed-out evidence. Authenticate with your approved vendor flow, then re-check the session.';
    primaryClass = 'auth-state--attention';
    primarySymbol = '!';
  } else if (check.kind === 'cancelled') {
    primaryHeading = 'Authentication check cancelled';
    primaryDetail = 'The session state was not changed or inferred from the cancelled check.';
    primaryClass = 'auth-state--neutral';
    primarySymbol = '–';
  } else if (check.kind === 'failed') {
    primaryHeading = 'Authentication check failed';
    primaryDetail = check.failure.message;
    primaryClass = 'auth-state--failed';
    primarySymbol = '!';
  }

  const hasIdentity =
    check.kind === 'authenticated' &&
    (check.identity.account !== undefined || check.identity.username !== undefined || check.identity.user !== undefined);

  const settingsID = headingID + '-settings';
  const context: SignInContext = {
    status, tool, headingID, ready: toolView.ready, checkKind: check.kind,
    verifySession: startCheck, onToolsChanged,
    invalidateSession: () => {
      attemptRef.current += 1;
      closeStreamRef.current?.();
      closeStreamRef.current = null;
      activeRunRef.current = null;
      stdoutRef.current = '';
      stderrRef.current = '';
      setCheck({ kind: 'unchecked' });
    },
    openSettings: () => setSettingsOpen(true),
    settingsOpen,
  };

  return (
    <article className="panel auth-status-card" aria-labelledby={headingID}>
      <div className="auth-card-header">
        <ToolIcon tool={tool} />
        <div className="auth-card-title">
          <h3 id={headingID}>{label}</h3>
          <p>{tool.toolId}{tool.version ? ' ' + tool.version : ''} · <span>{toolView.statusText}</span></p>
        </div>
        <button type="button" className="icon-button auth-settings-toggle" aria-label={label + ' settings'}
          aria-expanded={settingsOpen} aria-controls={settingsID} onClick={() => setSettingsOpen((open) => !open)}>
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
          </svg>
        </button>
      </div>

      <div className={'auth-primary-state ' + primaryClass} role="status" aria-live="polite" aria-atomic="true">
        <span className="auth-state-symbol" aria-hidden="true">{primarySymbol}</span>
        <div>
          <h4>{primaryHeading}</h4>
          <p>{primaryDetail}</p>
        </div>
      </div>

      {!toolView.ready && <p className="auth-remediation">{toolView.nextStep}</p>}
      {check.kind === 'failed' && check.failure.remediation && (
        <p className="auth-remediation">{check.failure.remediation}</p>
      )}

      {hasIdentity && (
        <dl className="auth-identity">
          {check.identity.account !== undefined && <div><dt>Account</dt><dd>{check.identity.account}</dd></div>}
          {check.identity.username !== undefined && <div><dt>Username</dt><dd>{check.identity.username}</dd></div>}
          {check.identity.user !== undefined && <div><dt>User</dt><dd>{check.identity.user}</dd></div>}
        </dl>
      )}

      {signIn !== undefined
        ? signIn.render(context)
        : toolView.ready && (
          <p className="auth-tool-meta">
            Sign in with your organization’s approved {tool.toolId} flow, then use the session check here to confirm it.
          </p>
        )}

      <div className="auth-actions">
        {tool.sessionCheck !== undefined && (
          <button type="button" disabled={!canCheck || check.kind === 'checking'} onClick={() => void startCheck()}>
            {check.kind === 'checking'
              ? 'Checking session…'
              : check.kind === 'unchecked'
                ? 'Check session'
                : 'Re-check session'}
          </button>
        )}
        {check.kind === 'checking' && check.runId !== undefined && (
          <button type="button" className="secondary-button" onClick={() => void cancelCheck()}>
            Cancel check
          </button>
        )}
        {(check.kind === 'authenticated' || (toolView.ready && tool.sessionCheck === undefined)) && (
          <button type="button" className="secondary-button" onClick={onOpenTasks}>
            Continue to tasks
          </button>
        )}
        {showDiagnostics && (
          <button type="button" className="secondary-button" onClick={onOpenDiagnostics}>
            Open diagnostics
          </button>
        )}
      </div>

      {settingsOpen && (
        <section id={settingsID} className="auth-settings" aria-label={label + ' settings'}>
          {signIn?.settings?.(context)}
          <dl className="auth-settings-meta">
            <div><dt>Pack</dt><dd>{tool.packId}</dd></div>
            <div><dt>Runtime status</dt><dd>{tool.status}</dd></div>
            {tool.versionConstraint && <div><dt>Version requirement</dt><dd>{tool.versionConstraint}</dd></div>}
          </dl>
          {!showDiagnostics && (
            <button type="button" className="secondary-button" onClick={onOpenDiagnostics}>Open diagnostics</button>
          )}
        </section>
      )}
    </article>
  );
}

export function AuthenticationPage({
  status,
  tasks,
  tools,
  onOpenTasks,
  onOpenDiagnostics,
  onToolsChanged,
  signInFor,
}: AuthenticationPageProps) {
  const vendorSessionTools = useMemo(
    () => tools.filter((tool) => tool.requiresVendorSession === true),
    [tools],
  );
  const noSignInTools = tools.filter((tool) => tool.requiresVendorSession !== true);

  return (
    <section className="auth-page" aria-labelledby="authentication-heading">
      <div className="route-heading">
        <h2 id="authentication-heading">Sign in</h2>
        <p>Sign in to each installed CLI. Use a CLI’s settings to choose its backend. Sessions stay owned by the vendor CLI.</p>
      </div>

      <div className="auth-layout">
        {vendorSessionTools.length === 0 ? (
          <article className="panel auth-status-card">
            <h3>No sign-in needed</h3>
            <p>None of the installed CLIs declare a vendor sign-in requirement.</p>
          </article>
        ) : (
          vendorSessionTools.map((tool) => (
            <VendorSessionCard
              key={
                tool.packId +
                '/' +
                tool.toolId +
                '/' +
                tool.packVersion +
                '/' +
                tool.status +
                '/' +
                (tool.version ?? 'unknown-version') +
                '/' +
                (tool.credentialLogin?.method ?? 'external-login') +
                '/' +
                (tool.credentialLogin?.method === 'conjur-password' && tool.credentialLogin.setupRequired ? 'setup' : 'configured') +
                '/' +
                (tool.sessionCheck?.commandId ?? 'no-check')
              }
              status={status}
              tasks={tasks}
              tool={tool}
              onOpenTasks={onOpenTasks}
              onOpenDiagnostics={onOpenDiagnostics}
              onToolsChanged={onToolsChanged}
              signIn={signInFor?.(tool)}
            />
          ))
        )}
      </div>

      {noSignInTools.length > 0 && (
        <p className="auth-no-sign-in">
          No sign-in needed: {noSignInTools.map((tool) => tool.packName || tool.toolId).join(', ')}
        </p>
      )}
    </section>
  );
}

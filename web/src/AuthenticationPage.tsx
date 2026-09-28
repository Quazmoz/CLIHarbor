import { useEffect, useMemo, useRef, useState } from 'react';
import { normalizeError, type AppErrorDetail } from './api/errors';
import type { RuntimeStatus } from './api/status';
import type { Task } from './api/tasks';
import type { ToolDiagnostic, ToolStatus } from './api/tools';
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

type AuthenticationCheck =
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

interface AuthenticationPageProps {
  status: RuntimeStatus;
  tasks: Task[];
  tools: ToolDiagnostic[];
  onOpenTasks: () => void;
  onOpenDiagnostics: () => void;
}

interface ToolReadinessView {
  heading: string;
  detail: string;
  statusText: string;
  ready: boolean;
}

interface VendorSessionCardProps {
  status: RuntimeStatus;
  tasks: Task[];
  tool: ToolDiagnostic;
  onOpenTasks: () => void;
  onOpenDiagnostics: () => void;
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

function describeTool(tool: ToolDiagnostic): ToolReadinessView {
  const label = tool.packName || tool.toolId;
  const detected = tool.version ? ' — ' + tool.version : '';
  const views: Record<ToolStatus, Omit<ToolReadinessView, 'ready'>> = {
    ready: {
      heading: label + ' ready',
      detail: 'The reviewed executable and version probe passed. Vendor authentication is checked separately when the pack declares a safe session check.',
      statusText: 'Ready' + detected,
    },
    missing: {
      heading: label + ' unavailable',
      detail: tool.message || 'CLIHarbor could not find the reviewed executable.',
      statusText: 'CLI unavailable',
    },
    ambiguous: {
      heading: label + ' selection is ambiguous',
      detail: tool.message || 'Multiple matching executables were found.',
      statusText: 'Tool unavailable',
    },
    incompatible: {
      heading: label + ' version is incompatible',
      detail: tool.message || 'The detected version does not satisfy the trusted pack requirement.',
      statusText: 'Version incompatible',
    },
    'probe-failed': {
      heading: label + ' probe failed',
      detail: tool.message || 'CLIHarbor could not verify the tool version.',
      statusText: 'Probe failed',
    },
    'invalid-override': {
      heading: label + ' override is invalid',
      detail: tool.message || 'The configured backend tool override is not usable.',
      statusText: 'Tool unavailable',
    },
    'identity-failed': {
      heading: label + ' identity verification failed',
      detail: tool.message || 'CLIHarbor could not verify the resolved executable identity.',
      statusText: 'Tool unavailable',
    },
    'unsupported-platform': {
      heading: label + ' is unsupported here',
      detail: tool.message || 'The trusted pack does not support this platform.',
      statusText: 'Tool unavailable',
    },
  };
  return { ...views[tool.status], ready: tool.status === 'ready' };
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
): void {
  for (const event of snapshot.events ?? []) {
    if (event.dataBase64 === undefined) {
      continue;
    }
    const text = decodeBase64Text(event.dataBase64);
    if (event.type === 'stdout.chunk') {
      stdoutRef.current = appendBounded(stdoutRef.current, text);
    } else if (event.type === 'stderr.chunk') {
      stderrRef.current = appendBounded(stderrRef.current, text);
    }
  }
}

function VendorSessionCard({
  status,
  tasks,
  tool,
  onOpenTasks,
  onOpenDiagnostics,
}: VendorSessionCardProps) {
  const [check, setCheck] = useState<AuthenticationCheck>({ kind: 'unchecked' });
  const attemptRef = useRef(0);
  const activeRunRef = useRef<string | null>(null);
  const closeStreamRef = useRef<(() => void) | null>(null);
  const stdoutRef = useRef('');
  const stderrRef = useRef('');

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

  const toolView = describeTool(tool);
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
    if (attempt !== attemptRef.current || event.dataBase64 === undefined) {
      return;
    }
    const text = decodeBase64Text(event.dataBase64);
    if (event.type === 'stdout.chunk') {
      stdoutRef.current = appendBounded(stdoutRef.current, text);
    } else if (event.type === 'stderr.chunk') {
      stderrRef.current = appendBounded(stderrRef.current, text);
    }
  };

  const reconcileAfterStreamFailure = (attempt: number, runId: string, streamFailure: AppErrorDetail) => {
    void fetchRun(runId).then(
      (snapshot) => {
        if (attempt !== attemptRef.current) {
          return;
        }
        try {
          evidenceFromSnapshot(snapshot, stdoutRef, stderrRef);
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
      evidenceFromSnapshot(snapshot, stdoutRef, stderrRef);

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
    label + ' is ready, but CLIHarbor has not yet checked whether the vendor-owned session is authenticated.';
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
      'The reviewed session check returned the pack-declared signed-out evidence. Authenticate externally, then re-check the session.';
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

  return (
    <article className="panel auth-status-card" aria-labelledby={headingID}>
      <p className="status-label">{label} session</p>
      <div className="auth-tool-heading">
        <div>
          <h3 id={headingID}>{toolView.heading}</h3>
          <p>{toolView.detail}</p>
        </div>
        <span className={'tool-status ' + (toolView.ready ? 'tool-status--ready' : 'tool-status--attention')}>
          {toolView.statusText}
        </span>
      </div>

      <div className={'auth-primary-state ' + primaryClass} role="status" aria-live="polite" aria-atomic="true">
        <span className="auth-state-symbol" aria-hidden="true">{primarySymbol}</span>
        <div>
          <h3>{primaryHeading}</h3>
          <p>{primaryDetail}</p>
        </div>
      </div>

      {check.kind === 'failed' && check.failure.remediation && (
        <p className="auth-remediation">{check.failure.remediation}</p>
      )}

      {check.kind === 'authenticated' && (
        <div className="auth-evidence">
          <p className="auth-evidence-title">Verified session evidence</p>
          <dl>
            {hasIdentity && check.identity.account !== undefined && (
              <div>
                <dt>Account</dt>
                <dd>{check.identity.account}</dd>
              </div>
            )}
            {hasIdentity && check.identity.username !== undefined && (
              <div>
                <dt>Username</dt>
                <dd>{check.identity.username}</dd>
              </div>
            )}
            {hasIdentity && check.identity.user !== undefined && (
              <div>
                <dt>User</dt>
                <dd>{check.identity.user}</dd>
              </div>
            )}
            <div>
              <dt>Evidence</dt>
              <dd>{sessionTask?.name ?? tool.sessionCheck?.commandId ?? 'Session check'} exited successfully</dd>
            </div>
          </dl>
        </div>
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

      {tool.versionConstraint && (
        <p className="auth-tool-meta">Trusted version requirement: {tool.versionConstraint}</p>
      )}
      <p className="auth-boundary-note">
        CLI readiness and vendor authentication are separate. A discovered executable does not prove that a vendor session is signed in.
      </p>
    </article>
  );
}

export function AuthenticationPage({
  status,
  tasks,
  tools,
  onOpenTasks,
  onOpenDiagnostics,
}: AuthenticationPageProps) {
  const vendorSessionTools = useMemo(
    () => tools.filter((tool) => tool.requiresVendorSession === true),
    [tools],
  );

  return (
    <section className="auth-page" aria-labelledby="authentication-heading">
      <div className="route-heading">
        <p className="status-label">Vendor sessions</p>
        <h2 id="authentication-heading">Authentication</h2>
        <p>
          Verify reviewed vendor-owned CLI sessions without giving CLIHarbor a password, MFA value, API key, token,
          certificate, or other credential.
        </p>
      </div>

      <div className="auth-layout">
        {vendorSessionTools.length === 0 ? (
          <article className="panel auth-status-card">
            <p className="status-label">Vendor sessions</p>
            <h3>No vendor-session workflows configured</h3>
            <p>The currently loaded trusted packs do not expose browser tasks that depend on vendor-owned authentication.</p>
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
                (tool.sessionCheck?.commandId ?? 'no-check')
              }
              status={status}
              tasks={tasks}
              tool={tool}
              onOpenTasks={onOpenTasks}
              onOpenDiagnostics={onOpenDiagnostics}
            />
          ))
        )}
      </div>

      <article className="panel auth-guidance" aria-labelledby="authentication-guidance-heading">
        <p className="status-label">Approved flow</p>
        <h3 id="authentication-guidance-heading">Authenticate outside CLIHarbor</h3>
        <p>
          CLIHarbor does not collect or store your vendor password. Authentication remains owned by your organization’s
          approved vendor CLI or identity process.
        </p>
        <p className="auth-guidance-step">
          Authenticate using the approved vendor-owned process, then return here and run a session check when the trusted pack
          declares one.
        </p>
        <p>
          CLIHarbor’s local browser session is a separate trust boundary from vendor sessions. This page reports readiness
          evidence only; it is not an authorization boundary and it does not bypass backend task policy.
        </p>
      </article>
    </section>
  );
}

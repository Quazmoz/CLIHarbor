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

const conjurPackID = 'cyberark-conjur-v9';
const conjurToolID = 'conjur';
const whoamiCommandID = 'whoami';
const maxAuthEvidenceChars = 64 * 1024;
const signedOutEvidence = 'please login again';

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

function describeTool(tool: ToolDiagnostic | undefined): ToolReadinessView {
  if (tool === undefined) {
    return {
      heading: 'Conjur CLI is not configured',
      detail: 'This runtime does not expose the reviewed Conjur tool. Load the trusted Conjur pack or inspect local diagnostics.',
      statusText: 'CLI unavailable',
      ready: false,
    };
  }

  const detected = tool.version ? ' — Conjur ' + tool.version : '';
  const views: Record<ToolStatus, Omit<ToolReadinessView, 'ready'>> = {
    ready: {
      heading: 'Conjur CLI ready',
      detail: 'The reviewed executable and version probe passed. Vendor authentication is checked separately.',
      statusText: 'Ready' + detected,
    },
    missing: {
      heading: 'Conjur CLI unavailable',
      detail: tool.message || 'CLIHarbor could not find the reviewed Conjur executable.',
      statusText: 'CLI unavailable',
    },
    ambiguous: {
      heading: 'Conjur CLI selection is ambiguous',
      detail: tool.message || 'Multiple matching Conjur executables were found.',
      statusText: 'Tool unavailable',
    },
    incompatible: {
      heading: 'Conjur CLI version is incompatible',
      detail: tool.message || 'The detected Conjur version does not satisfy the trusted pack requirement.',
      statusText: 'Version incompatible',
    },
    'probe-failed': {
      heading: 'Conjur CLI probe failed',
      detail: tool.message || 'CLIHarbor could not verify the Conjur version.',
      statusText: 'Probe failed',
    },
    'invalid-override': {
      heading: 'Conjur CLI override is invalid',
      detail: tool.message || 'The configured backend tool override is not usable.',
      statusText: 'Tool unavailable',
    },
    'identity-failed': {
      heading: 'Conjur CLI identity verification failed',
      detail: tool.message || 'CLIHarbor could not verify the resolved executable identity.',
      statusText: 'Tool unavailable',
    },
    'unsupported-platform': {
      heading: 'Conjur CLI is unsupported here',
      detail: tool.message || 'The trusted Conjur pack does not support this platform.',
      statusText: 'Tool unavailable',
    },
  };
  return { ...views[tool.status], ready: tool.status === 'ready' };
}

function failureFromRun(status: RunSnapshot['status'], failure?: AppErrorDetail): AuthCheckFailure | AppErrorDetail {
  if (failure !== undefined) {
    return failure;
  }
  switch (status) {
    case 'timed-out':
      return {
        message: 'The Conjur session check timed out.',
        remediation: 'Retry the check. If it continues to time out, open Diagnostics and verify the local vendor/runtime path.',
      };
    case 'cancelled':
      return {
        message: 'The Conjur session check was cancelled.',
        remediation: 'Select Re-check session when you are ready to verify the vendor session.',
      };
    case 'failed':
      return {
        message: 'CLIHarbor could not complete the Conjur session check.',
        remediation: 'Open Diagnostics for sanitized local readiness information, then retry.',
      };
    default:
      return {
        message: 'Conjur did not confirm an authenticated session.',
        remediation:
          'Authenticate using your organization’s approved Conjur / Secrets Manager CLI process, then return here and re-check the session. If you are already signed in, open Diagnostics.',
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

export function AuthenticationPage({
  status,
  tasks,
  tools,
  onOpenTasks,
  onOpenDiagnostics,
}: AuthenticationPageProps) {
  const [check, setCheck] = useState<AuthenticationCheck>({ kind: 'unchecked' });
  const attemptRef = useRef(0);
  const activeRunRef = useRef<string | null>(null);
  const closeStreamRef = useRef<(() => void) | null>(null);
  const stdoutRef = useRef('');
  const stderrRef = useRef('');

  const whoamiTask = useMemo(
    () =>
      tasks.find(
        (task) =>
          task.packId === conjurPackID &&
          task.commandId === whoamiCommandID &&
          task.toolId === conjurToolID &&
          task.requiresAuth === true,
      ),
    [tasks],
  );
  const conjurTool = useMemo(
    () => tools.find((tool) => tool.packId === conjurPackID && tool.toolId === conjurToolID),
    [tools],
  );
  const toolView = describeTool(conjurTool);
  const canCheck = toolView.ready && whoamiTask !== undefined;

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

    if (runStatus === 'exited' && stderrRef.current.toLowerCase().includes(signedOutEvidence)) {
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
      failure: failureFromRun(runStatus, failure),
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
            message: 'Live updates ended before CLIHarbor could verify the Conjur session.',
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
    if (!canCheck || check.kind === 'checking' || whoamiTask === undefined) {
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
        packId: whoamiTask.packId,
        commandId: whoamiTask.commandId,
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
    attemptRef.current += 1;
    closeStreamRef.current?.();
    closeStreamRef.current = null;
    activeRunRef.current = null;
    try {
      await cancelRun(status.csrfToken, runId);
      setCheck({ kind: 'cancelled', checkedAt: new Date().toISOString() });
    } catch (error) {
      setCheck({
        kind: 'failed',
        checkedAt: new Date().toISOString(),
        failure: normalizeError(error).detail,
      });
    }
  };

  let primaryHeading = 'Authentication not verified';
  let primaryDetail =
    'Conjur is ready, but CLIHarbor has not yet checked whether the vendor-owned session is authenticated.';
  let primaryClass = 'auth-state--neutral';
  let primarySymbol = '?';

  if (!toolView.ready) {
    primaryHeading = 'Tool unavailable';
    primaryDetail = 'CLIHarbor cannot check the Conjur session until the reviewed CLI is ready.';
    primaryClass = 'auth-state--attention';
    primarySymbol = '!';
  } else if (whoamiTask === undefined) {
    primaryHeading = 'Authentication check unavailable';
    primaryDetail = 'The trusted runtime did not expose the reviewed Conjur whoami task. Open Diagnostics before continuing.';
    primaryClass = 'auth-state--attention';
    primarySymbol = '!';
  } else if (check.kind === 'checking') {
    primaryHeading = 'Checking session';
    primaryDetail = 'CLIHarbor is running the reviewed read-only Conjur whoami workflow through the normal trusted execution path.';
    primaryClass = 'auth-state--checking';
    primarySymbol = '…';
  } else if (check.kind === 'authenticated') {
    primaryHeading = 'Authenticated';
    primaryDetail = 'The reviewed Conjur whoami workflow completed successfully using the vendor-owned session.';
    primaryClass = 'auth-state--authenticated';
    primarySymbol = '✓';
  } else if (check.kind === 'required') {
    primaryHeading = 'Authentication required';
    primaryDetail =
      'The pinned Conjur 9.3.1 workflow returned its reviewed signed-out evidence. Authenticate externally, then re-check the session.';
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
    <section className="auth-page" aria-labelledby="authentication-heading">
      <div className="route-heading">
        <p className="status-label">Vendor session</p>
        <h2 id="authentication-heading">Authentication</h2>
        <p>
          Verify the vendor-owned Conjur / Secrets Manager session without giving CLIHarbor a password, MFA value, API key,
          token, certificate, or other credential.
        </p>
      </div>

      <div className="auth-layout">
        <article className="panel auth-status-card" aria-labelledby="conjur-session-heading">
          <p className="status-label">Conjur session</p>
          <div className={'auth-primary-state ' + primaryClass} role="status" aria-live="polite" aria-atomic="true">
            <span className="auth-state-symbol" aria-hidden="true">{primarySymbol}</span>
            <div>
              <h3 id="conjur-session-heading">{primaryHeading}</h3>
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
                  <dd>Conjur whoami exited successfully</dd>
                </div>
              </dl>
            </div>
          )}

          <div className="auth-actions">
            <button type="button" disabled={!canCheck || check.kind === 'checking'} onClick={() => void startCheck()}>
              {check.kind === 'checking'
                ? 'Checking session…'
                : check.kind === 'unchecked'
                  ? 'Check session'
                  : 'Re-check session'}
            </button>
            {check.kind === 'checking' && check.runId !== undefined && (
              <button type="button" className="secondary-button" onClick={() => void cancelCheck()}>
                Cancel check
              </button>
            )}
            {check.kind === 'authenticated' && (
              <button type="button" className="secondary-button" onClick={onOpenTasks}>
                Continue to tasks
              </button>
            )}
            {!canCheck && (
              <button type="button" className="secondary-button" onClick={onOpenDiagnostics}>
                Open diagnostics
              </button>
            )}
            {check.kind === 'failed' && (
              <button type="button" className="secondary-button" onClick={onOpenDiagnostics}>
                Open diagnostics
              </button>
            )}
          </div>
        </article>

        <article className="panel auth-tool-card" aria-labelledby="conjur-tool-heading">
          <p className="status-label">Tool readiness</p>
          <div className="auth-tool-heading">
            <div>
              <h3 id="conjur-tool-heading">{toolView.heading}</h3>
              <p>{toolView.detail}</p>
            </div>
            <span className={'tool-status ' + (toolView.ready ? 'tool-status--ready' : 'tool-status--attention')}>
              {toolView.statusText}
            </span>
          </div>
          {conjurTool?.versionConstraint && (
            <p className="auth-tool-meta">Trusted version requirement: {conjurTool.versionConstraint}</p>
          )}
          <p className="auth-boundary-note">
            CLI readiness and Conjur authentication are separate. A discovered executable does not prove that a vendor session
            is signed in.
          </p>
        </article>
      </div>

      <article className="panel auth-guidance" aria-labelledby="authentication-guidance-heading">
        <p className="status-label">Approved flow</p>
        <h3 id="authentication-guidance-heading">Authenticate outside CLIHarbor</h3>
        <p>
          CLIHarbor does not collect or store your vendor password. Authentication remains owned by your organization’s
          approved Conjur / Secrets Manager process.
        </p>
        <p className="auth-guidance-step">
          Authenticate using your organization’s approved Conjur / Secrets Manager CLI process, then return here and check the
          session again.
        </p>
        <p>
          CLIHarbor’s local browser session is a separate trust boundary from the Conjur vendor session. This page reports
          session readiness; it is not an authorization boundary and it does not bypass backend task policy.
        </p>
      </article>
    </section>
  );
}

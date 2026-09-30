import { useEffect, useMemo, useRef, useState } from 'react';
import { loginWithCredentials } from './api/authentication';
import { normalizeError, type AppErrorDetail } from './api/errors';
import type { RuntimeStatus } from './api/status';
import type { Task } from './api/tasks';
import type { ToolDiagnostic } from './api/tools';
import { describeToolReadiness } from './operatorLanguage';
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
  const [credentialIdentity, setCredentialIdentity] = useState('');
  const [credentialSecret, setCredentialSecret] = useState('');
  const [credentialSubmitting, setCredentialSubmitting] = useState(false);
  const [credentialFailure, setCredentialFailure] = useState<AppErrorDetail | null>(null);

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

  const submitCredentialLogin = async () => {
    if (
      tool.credentialLogin?.method !== 'conjur-password' ||
      !toolView.ready ||
      credentialSubmitting ||
      check.kind === 'checking'
    ) {
      return;
    }

    const identity = credentialIdentity.trim();
    const secret = credentialSecret;
    if (identity.length === 0 || secret.length === 0) {
      return;
    }

    setCredentialSubmitting(true);
    setCredentialFailure(null);
    try {
      await loginWithCredentials(status.csrfToken, {
        packId: tool.packId,
        toolId: tool.toolId,
        identity,
        secret,
      });
      setCredentialSecret('');
      await startCheck();
    } catch (error) {
      setCredentialFailure(normalizeError(error).detail);
    } finally {
      setCredentialSecret('');
      setCredentialSubmitting(false);
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
      <p className="status-label">{label} sign-in</p>
      <div className="auth-tool-heading">
        <div>
          <h3 id={headingID}>{toolView.heading}</h3>
          <p>{toolView.summary}</p>
          {!toolView.ready && <p className="auth-remediation">{toolView.nextStep}</p>}
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

      {tool.credentialLogin?.method === 'conjur-password' && toolView.ready && (
        <form
          className="credential-login-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submitCredentialLogin();
          }}
        >
          <div className="credential-login-heading">
            <div>
              <p className="status-label">Secure sign-in</p>
              <h4>Sign in through the local Conjur bridge</h4>
            </div>
            <span className="safety-chip">No credential argv</span>
          </div>
          <p id={headingID + '-credential-help'} className="credential-login-help">
            Your identity and password are sent only to this authenticated loopback runtime for the current sign-in attempt.
            CLIHarbor does not add them to run history, command arguments, logs, or its own storage. The pinned Conjur API
            exchanges the password and writes the resulting vendor credential through Conjur's configured credential storage.
          </p>
          <div className="credential-login-fields">
            <label className="field">
              <span>Identity</span>
              <input
                type="text"
                name="vendor-identity"
                value={credentialIdentity}
                maxLength={256}
                autoComplete="off"
                spellCheck={false}
                aria-describedby={headingID + '-credential-help'}
                disabled={credentialSubmitting || check.kind === 'checking'}
                onChange={(event) => {
                  setCredentialIdentity(event.target.value);
                  setCredentialFailure(null);
                }}
                required
              />
            </label>
            <label className="field">
              <span>Password</span>
              <input
                type="password"
                name="vendor-secret"
                value={credentialSecret}
                maxLength={4096}
                autoComplete="off"
                spellCheck={false}
                aria-describedby={headingID + '-credential-help'}
                disabled={credentialSubmitting || check.kind === 'checking'}
                onChange={(event) => {
                  setCredentialSecret(event.target.value);
                  setCredentialFailure(null);
                }}
                required
              />
            </label>
          </div>
          {credentialFailure !== null && (
            <div className="credential-login-error" role="alert">
              <strong>{credentialFailure.message}</strong>
              {credentialFailure.remediation && <span>{credentialFailure.remediation}</span>}
            </div>
          )}
          <div className="credential-login-actions">
            <button
              type="submit"
              disabled={
                credentialSubmitting ||
                check.kind === 'checking' ||
                credentialIdentity.trim().length === 0 ||
                credentialSecret.length === 0
              }
            >
              {credentialSubmitting ? 'Signing in…' : 'Sign in and verify'}
            </button>
          </div>
        </form>
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

      <details className="technical-details auth-boundary-note">
        <summary>Technical sign-in details</summary>
        <p>CLI readiness and vendor authentication are separate. A discovered executable does not prove that a vendor session is signed in.</p>
        {tool.versionConstraint && <p>Trusted version requirement: {tool.versionConstraint}</p>}
        <p>Pack: {tool.packId} · Tool: {tool.toolId} · Runtime status: {tool.status}</p>
      </details>
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
        <p className="status-label">Sign-in status</p>
        <h2 id="authentication-heading">Authentication</h2>
        <p>
          Check whether approved tools are signed in, sign in through a reviewed local bridge where supported, or use your
          organization’s normal vendor sign-in process. CLIHarbor never treats an installed tool as proof of authentication.
        </p>
      </div>

      <div className="auth-layout">
        {vendorSessionTools.length === 0 ? (
          <article className="panel auth-status-card">
            <p className="status-label">Sign-in status</p>
            <h3>No sign-in checks are needed</h3>
            <p>The available browser tasks do not declare a vendor authentication requirement.</p>
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
        <h3 id="authentication-guidance-heading">Sign in safely, then verify</h3>
        <p>
          CLIHarbor never persists the password you enter. For supported Conjur password authentication, the browser submits it
          only to the authenticated loopback backend, which hands it directly to the pinned vendor API. The resulting vendor
          credential remains owned by Conjur's configured credential storage.
        </p>
        <p className="auth-guidance-step">
          OIDC, JWT, MFA, certificate, and other interactive or non-password modes remain vendor-owned. Use your organization's
          approved vendor authentication process for those modes, then return here and run the reviewed session check.
        </p>
        <p>
          CLIHarbor’s local browser session is a separate trust boundary from vendor sessions. A successful sign-in still does
          not bypass backend task policy, and the session check remains the authoritative browser-visible evidence.
        </p>
      </article>
    </section>
  );
}

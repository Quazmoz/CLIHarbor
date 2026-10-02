import { useEffect, useMemo, useRef, useState } from 'react';
import { configureCredentialConnection, launchInteractiveLogin, loginWithCredentials } from './api/authentication';
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

export function VendorSessionCard({
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
  const [vendorLoginOpened, setVendorLoginOpened] = useState(false);
  const [credentialConnectionReady, setCredentialConnectionReady] = useState(
    tool.credentialLogin?.method !== 'conjur-password' || tool.credentialLogin.setupRequired !== true,
  );
  const [credentialApplianceURL, setCredentialApplianceURL] = useState('');
  const [credentialAccount, setCredentialAccount] = useState('');
  const [credentialAuthnType, setCredentialAuthnType] = useState<'authn' | 'ldap'>('authn');
  const [credentialServiceID, setCredentialServiceID] = useState('');

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

  const submitCredentialConfiguration = async () => {
    if (
      tool.credentialLogin?.method !== 'conjur-password' ||
      !toolView.ready ||
      credentialConnectionReady ||
      credentialSubmitting ||
      check.kind === 'checking'
    ) {
      return;
    }

    const applianceUrl = credentialApplianceURL.trim();
    const account = credentialAccount.trim();
    const serviceId = credentialServiceID.trim();
    if (
      applianceUrl.length === 0 ||
      account.length === 0 ||
      (credentialAuthnType === 'ldap' && serviceId.length === 0)
    ) {
      return;
    }

    setCredentialSubmitting(true);
    setCredentialFailure(null);
    setCredentialSecret('');
    try {
      await configureCredentialConnection(status.csrfToken, {
        packId: tool.packId,
        toolId: tool.toolId,
        applianceUrl,
        account,
        authnType: credentialAuthnType,
        ...(credentialAuthnType === 'ldap' ? { serviceId } : {}),
      });
      setCredentialConnectionReady(true);
    } catch (error) {
      setCredentialFailure(normalizeError(error).detail);
    } finally {
      setCredentialSubmitting(false);
    }
  };

  const submitCredentialLogin = async () => {
    if (
      tool.credentialLogin?.method !== 'conjur-password' ||
      !toolView.ready ||
      !credentialConnectionReady ||
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

  const launchVendorLogin = async () => {
    if (
      tool.credentialLogin?.method !== 'conjur-vendor-login' ||
      !toolView.ready ||
      credentialSubmitting ||
      check.kind === 'checking'
    ) {
      return;
    }

    setCredentialSubmitting(true);
    setCredentialFailure(null);
    setVendorLoginOpened(false);
    try {
      await launchInteractiveLogin(status.csrfToken, {
        packId: tool.packId,
        toolId: tool.toolId,
      });
      setVendorLoginOpened(true);
    } catch (error) {
      setCredentialFailure(normalizeError(error).detail);
    } finally {
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
      tool.credentialLogin?.method === 'conjur-password'
        ? 'Your Conjur session is signed out. Use the sign-in form below and CLIHarbor will verify the session automatically.'
        : tool.credentialLogin?.method === 'conjur-vendor-login'
          ? 'Your Conjur session is signed out. Start the official Conjur sign-in flow below, complete any vendor browser or terminal interaction, then re-check the session.'
          : 'The reviewed session check returned the pack-declared signed-out evidence. Authenticate with your approved vendor flow, then re-check the session.';
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

      {toolView.ready && tool.credentialLogin === undefined && (
        <div className="credential-login-error" role="status">
          <strong>CLI detected; browser sign-in is unavailable for the current vendor configuration.</strong>
          <span>
            Detection and authentication are separate. CLIHarbor can still run the reviewed session check. If you expected the
            built-in Conjur password form, review Diagnostics and the current Conjur connection/authentication mode instead of
            reinstalling the CLI.
          </span>
        </div>
      )}

      {tool.credentialLogin?.method === 'conjur-password' && toolView.ready && (
        <form
          className="credential-login-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (credentialConnectionReady) {
              void submitCredentialLogin();
            } else {
              void submitCredentialConfiguration();
            }
          }}
        >
          <div className="credential-login-heading">
            <div>
              <p className="status-label">Conjur sign-in</p>
              <h4>{credentialConnectionReady ? 'Sign in to Conjur' : 'Connect to Conjur'}</h4>
            </div>
            <span className="safety-chip">{credentialConnectionReady ? 'Password stays local' : 'No password yet'}</span>
          </div>

          {!credentialConnectionReady && (
            <div className="credential-setup-section">
              <div>
                <p className="credential-step-label">Step 1 of 2 · Connection</p>
                <p className="credential-login-help" id={headingID + '-connection-help'}>
                  Enter the HTTPS Conjur server and account your organization gave you. CLIHarbor asks the reviewed Conjur CLI
                  to create its normal current-user connection configuration. No password is requested or sent until this step
                  succeeds, and insecure or self-signed bypass flags are never accepted.
                </p>
              </div>
              <div className="credential-login-fields">
                <label className="field">
                  <span>Conjur server URL</span>
                  <input
                    type="url"
                    name="conjur-appliance-url"
                    value={credentialApplianceURL}
                    maxLength={2048}
                    placeholder="https://conjur.example.com"
                    autoComplete="off"
                    spellCheck={false}
                    aria-describedby={headingID + '-connection-help'}
                    disabled={credentialSubmitting || check.kind === 'checking'}
                    onChange={(event) => {
                      setCredentialApplianceURL(event.target.value);
                      setCredentialFailure(null);
                    }}
                    required
                  />
                </label>
                <label className="field">
                  <span>Account</span>
                  <input
                    type="text"
                    name="conjur-account"
                    value={credentialAccount}
                    maxLength={256}
                    autoComplete="off"
                    spellCheck={false}
                    aria-describedby={headingID + '-connection-help'}
                    disabled={credentialSubmitting || check.kind === 'checking'}
                    onChange={(event) => {
                      setCredentialAccount(event.target.value);
                      setCredentialFailure(null);
                    }}
                    required
                  />
                </label>
                <label className="field">
                  <span>Authentication method</span>
                  <select
                    name="conjur-authn-type"
                    value={credentialAuthnType}
                    aria-describedby={headingID + '-connection-help'}
                    disabled={credentialSubmitting || check.kind === 'checking'}
                    onChange={(event) => {
                      setCredentialAuthnType(event.target.value === 'ldap' ? 'ldap' : 'authn');
                      setCredentialFailure(null);
                    }}
                  >
                    <option value="authn">Conjur username and password</option>
                    <option value="ldap">LDAP username and password</option>
                  </select>
                </label>
                {credentialAuthnType === 'ldap' && (
                  <label className="field">
                    <span>LDAP authenticator service ID</span>
                    <input
                      type="text"
                      name="conjur-service-id"
                      value={credentialServiceID}
                      maxLength={256}
                      autoComplete="off"
                      spellCheck={false}
                      aria-describedby={headingID + '-connection-help'}
                      disabled={credentialSubmitting || check.kind === 'checking'}
                      onChange={(event) => {
                        setCredentialServiceID(event.target.value);
                        setCredentialFailure(null);
                      }}
                      required
                    />
                  </label>
                )}
              </div>
            </div>
          )}

          {credentialConnectionReady && (
            <div className="credential-setup-section">
              <div>
                {tool.credentialLogin.setupRequired === true && <p className="credential-step-label">Step 2 of 2 · Credentials</p>}
                <p id={headingID + '-credential-help'} className="credential-login-help">
                  Enter your normal Conjur identity and password. The password is sent only to this authenticated local runtime
                  for this attempt, never placed in command arguments or run history, and cleared from the form after submission.
                  Conjur remains responsible for its resulting vendor credential.
                </p>
              </div>
              <div className="credential-login-fields">
                <label className="field">
                  <span>Identity</span>
                  <input
                    type="text"
                    name="vendor-identity"
                    value={credentialIdentity}
                    maxLength={256}
                    autoComplete="username"
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
                    autoComplete="current-password"
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
            </div>
          )}

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
                (credentialConnectionReady
                  ? credentialIdentity.trim().length === 0 || credentialSecret.length === 0
                  : credentialApplianceURL.trim().length === 0 ||
                    credentialAccount.trim().length === 0 ||
                    (credentialAuthnType === 'ldap' && credentialServiceID.trim().length === 0))
              }
            >
              {credentialSubmitting
                ? credentialConnectionReady
                  ? 'Signing in…'
                  : 'Saving connection…'
                : credentialConnectionReady
                  ? 'Sign in and verify'
                  : 'Save connection and continue'}
            </button>
          </div>
        </form>
      )}

      {tool.credentialLogin?.method === 'conjur-vendor-login' && toolView.ready && (
        <div className="credential-login-form">
          <div className="credential-login-heading">
            <div>
              <p className="status-label">Official Conjur sign-in</p>
              <h4>Continue with the vendor login flow</h4>
            </div>
            <span className="safety-chip">Credentials stay vendor-owned</span>
          </div>
          <p className="credential-login-help">
            CLIHarbor starts the exact verified Conjur CLI with only the reviewed <code>login</code> argument. OIDC and
            JWT run without a CLIHarbor console; OIDC may open the vendor browser flow. Idira SaaS/cloud may open a
            separate vendor-owned terminal when interactive challenges are required. CLIHarbor does not receive or record
            credentials from this flow.
          </p>
          {credentialFailure !== null && (
            <div className="credential-login-error" role="alert">
              <strong>{credentialFailure.message}</strong>
              {credentialFailure.remediation && <span>{credentialFailure.remediation}</span>}
            </div>
          )}
          {vendorLoginOpened && (
            <div className="credential-login-success" role="status">
              <strong>Official Conjur sign-in started.</strong>
              <span>Complete any vendor browser or terminal flow, then select Check session to verify the session.</span>
            </div>
          )}
          <div className="credential-login-actions">
            <button
              type="button"
              disabled={credentialSubmitting || check.kind === 'checking'}
              onClick={() => void launchVendorLogin()}
            >
              {credentialSubmitting ? 'Starting Conjur sign-in…' : vendorLoginOpened ? 'Start Conjur sign-in again' : 'Start official Conjur sign-in'}
            </button>
          </div>
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
          Check whether approved tools are signed in and use the built-in Conjur form when password sign-in is supported. On a
          new computer, CLIHarbor can also guide the reviewed Conjur CLI through its normal connection setup before signing in.
          Other authentication modes continue to use your organization’s approved vendor flow.
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
          When the current Conjur configuration uses a reviewed vendor-owned login mode such as OIDC, JWT, or Idira SaaS,
          CLIHarbor starts the exact verified Conjur CLI with fixed <code>login</code> argv. OIDC/JWT avoid an unnecessary
          console window; SaaS/cloud retains a vendor-owned terminal when interactive challenges require it. Unsupported
          modes such as certificate/IAM/Azure/GCP remain outside CLIHarbor and continue through your organization's approved flow.
        </p>
        <p>
          CLIHarbor’s local browser session is a separate trust boundary from vendor sessions. A successful sign-in still does
          not bypass backend task policy, and the session check remains the authoritative browser-visible evidence.
        </p>
      </article>
    </section>
  );
}

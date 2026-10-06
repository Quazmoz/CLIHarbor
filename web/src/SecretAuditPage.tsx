import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { normalizeError, type AppErrorDetail } from './api/errors';
import {
  cancelSecretAudit,
  fetchSecretAudit,
  startSecretAudit,
  type SecretAuditConfidence,
  type SecretAuditScanType,
  type SecretAuditSnapshot,
} from './api/secretAudit';

const POLL_MS = 1000;

const reasonText: Record<string, string> = {
  exact_known_variable_reference: 'Value is exactly the ID of another Conjur variable.',
  normalized_known_variable_reference: 'Value is another variable’s path written with dots or backslashes.',
  secret_reference_uri: 'Value is a conjur://, cyberark:// or idira:// reference.',
  dot_notation_reference_shape: 'Value looks like a dotted path ending in a credential field.',
  path_with_secret_field_suffix: 'Value looks like a path ending in password, token, key or similar.',
  hierarchical_reference_shape: 'Value is a deep path with no other content.',
  contains_text_match: 'Value contains the specified text.',
  exact_text_match: 'Value exactly matches the specified text.',
  regex_match: 'Value matches the specified regular expression.',
};

const scanTypeText: Record<SecretAuditScanType, string> = {
  references: 'Secret references and paths',
  contains: 'Contains text',
  exact: 'Exact text',
  regex: 'Regular expression',
};

const failureCodeText: Record<string, string> = {
  no_value: 'No value has been set yet.',
  forbidden: 'Your identity cannot read (execute) this variable.',
  output_limit_exceeded: 'Value is larger than 1 MiB and was skipped.',
  retrieval_failed: 'Conjur did not return the value.',
  unsupported_encoding: 'Value is not UTF-8 text and was skipped.',
};

const auditFailureText: Record<string, { title: string; detail: string; action?: 'authentication' | 'diagnostics' }> = {
  session_required: {
    title: 'Sign in to Conjur first',
    detail: 'The audit reuses the session stored by the Conjur CLI, and there is no valid session.',
    action: 'authentication',
  },
  not_configured: {
    title: 'Conjur connection is not set up',
    detail: 'Add the Conjur server and account on the Authentication page, then sign in.',
    action: 'authentication',
  },
  backend_mismatch: {
    title: 'Sign in to the selected backend',
    detail: 'The URL differs from your Conjur CLI configuration. Configure the Conjur CLI for this backend and account, then sign in. Return here to scan with that session.',
    action: 'authentication',
  },
  too_many_variables: {
    title: 'Too many variables to audit safely',
    detail: 'This identity can see more than 50,000 variables. Use the PowerShell audit with an explicit -MaxVariables for very large inventories.',
  },
  inventory_changed: {
    title: 'Variables changed during the audit',
    detail: 'Variables were added, removed, or reordered while the audit ran, so the results would be incomplete. Run it again when the inventory is stable.',
  },
  invalid_inventory: {
    title: 'Conjur returned an unexpected variable list',
    detail: 'A variable ID was malformed or contained unsafe characters. No partial results are shown.',
  },
  unavailable: {
    title: 'Conjur could not be reached',
    detail: 'Check the network connection and the Conjur server, then try again.',
    action: 'diagnostics',
  },
};

const phaseText: Record<string, string> = {
  connecting: 'Connecting to Conjur',
  listing: 'Listing visible variables',
  reading: 'Reading and classifying values',
  verifying: 'Checking that the inventory did not change',
};

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function downloadReport(snapshot: SecretAuditSnapshot) {
  // Same redacted shape as the PowerShell report: identifiers and codes only.
  const report = {
    schemaVersion: 2,
    generatedAtUtc: snapshot.finishedAt,
    target: snapshot.target,
    totalVariables: snapshot.total,
    inspectedValues: snapshot.inspected,
    matchingVariables: snapshot.findings.length,
    retrievalFailures: snapshot.failures.length,
    minimumConfidence: snapshot.minimumConfidence,
    scanType: snapshot.scanType ?? 'references',
    findings: snapshot.findings,
    failures: snapshot.failures,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'conjur-secret-value-audit.json';
  link.click();
  URL.revokeObjectURL(url);
}

interface SecretAuditPageProps {
  csrfToken: string;
  onOpenAuthentication: () => void;
  onOpenDiagnostics: () => void;
}

export function SecretAuditPage({ csrfToken, onOpenAuthentication, onOpenDiagnostics }: SecretAuditPageProps) {
  const [snapshot, setSnapshot] = useState<SecretAuditSnapshot | null>(null);
  const [failure, setFailure] = useState<AppErrorDetail | null>(null);
  const [minimum, setMinimum] = useState<SecretAuditConfidence>('medium');
  const [scanType, setScanType] = useState<SecretAuditScanType>('references');
  const [pattern, setPattern] = useState('');
  const [applianceURL, setApplianceURL] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const [copied, setCopied] = useState('');
  const resultHeadingRef = useRef<HTMLHeadingElement>(null);
  const previousStateRef = useRef<string | undefined>(undefined);

  const running = snapshot?.state === 'running';

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    const poll = () => {
      fetchSecretAudit(controller.signal).then(
        (next) => {
          setSnapshot(next);
          setFailure(null);
          if (next.state === 'running') timer = window.setTimeout(poll, POLL_MS);
        },
        (error: unknown) => {
          if (!isAbort(error)) setFailure(normalizeError(error).detail);
        },
      );
    };
    poll();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
    // Re-arm polling whenever an audit starts.
  }, [running]);

  useEffect(() => {
    const state = snapshot?.state;
    if (previousStateRef.current === 'running' && state !== 'running') {
      resultHeadingRef.current?.focus();
    }
    previousStateRef.current = state;
  }, [snapshot?.state]);

  const act = useCallback(async (action: () => Promise<SecretAuditSnapshot>) => {
    setBusy(true);
    setFailure(null);
    try {
      setSnapshot(await action());
    } catch (error) {
      setFailure(normalizeError(error).detail);
    } finally {
      setBusy(false);
    }
  }, []);

  const visibleFindings = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return (snapshot?.findings ?? []).filter((finding) => needle === '' || finding.variableId.toLowerCase().includes(needle));
  }, [snapshot, filter]);

  const copy = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
    } catch {
      setCopied('');
    }
  };

  const header = (
    <div className="route-heading">
      <p className="status-label">Conjur maintenance · read-only</p>
      <h2 id="secret-audit-heading">Conjur security audit</h2>
      <p>
        Scan secret values for references, path patterns, or text you choose. CLIHarbor reads and checks each value
        on this computer. This page only ever
        receives variable IDs and the reason each one was flagged. Values are never shown, copied, or saved.
      </p>
    </div>
  );

  if (snapshot === null) {
    return (
      <section className="secret-audit-page" aria-labelledby="secret-audit-heading">
        {header}
        {failure ? (
          <div className="failure-notice" role="alert">
            <strong>{failure.message}</strong>
            {failure.remediation && <p>{failure.remediation}</p>}
          </div>
        ) : (
          <p role="status">Loading audit status…</p>
        )}
      </section>
    );
  }

  if (!snapshot.available) {
    return (
      <section className="secret-audit-page" aria-labelledby="secret-audit-heading">
        {header}
        <div className="empty-state">
          <strong>The Conjur CLI is not ready.</strong>
          <p>The audit needs a ready Conjur CLI from the trusted Conjur pack. Check Diagnostics, then sign in on the Authentication page.</p>
          <div className="secret-audit-actions">
            <button type="button" onClick={onOpenDiagnostics}>Open Diagnostics</button>
            <button type="button" className="secondary-button" onClick={onOpenAuthentication}>Open Authentication</button>
          </div>
        </div>
      </section>
    );
  }

  const percent = snapshot.total > 0 ? Math.round((snapshot.processed / snapshot.total) * 100) : 0;
  const auditFailure = snapshot.state === 'failed' ? auditFailureText[snapshot.failureCode ?? ''] ?? auditFailureText.unavailable : undefined;
  const completed = snapshot.state === 'completed';

  return (
    <section className="secret-audit-page" aria-labelledby="secret-audit-heading">
      {header}

      <div className="secret-audit-layout">
        <article className="panel" aria-labelledby="secret-audit-setup-heading">
          <p className="status-label">{running ? 'In progress' : 'Set up'}</p>
          <h3 id="secret-audit-setup-heading">{running ? 'Audit running' : 'Run an audit'}</h3>

          <dl className="secret-audit-target" aria-label="Audit target">
            <div>
              <dt>Server</dt>
              <dd>{snapshot.target?.applianceUrl ?? 'Not configured'}</dd>
            </div>
            <div>
              <dt>Account</dt>
              <dd>{snapshot.target?.account || '—'}</dd>
            </div>
            <div>
              <dt>Scope</dt>
              <dd>Every variable your signed-in identity can see</dd>
            </div>
          </dl>

          {running ? (
            <div className="secret-audit-progress">
              {/* Announce phase changes only; the count updates every poll and would be noisy. */}
              <p role="status" aria-live="polite">{phaseText[snapshot.phase ?? ''] ?? 'Working'}</p>
              {snapshot.phase === 'reading' && (
                <p aria-hidden="true">
                  {snapshot.processed.toLocaleString()} of {snapshot.total.toLocaleString()} variables
                </p>
              )}
              <progress
                max={100}
                value={snapshot.phase === 'reading' || snapshot.phase === 'verifying' ? percent : undefined}
                aria-label="Audit progress"
                aria-valuetext={snapshot.phase === 'reading' ? `${snapshot.processed} of ${snapshot.total} variables` : undefined}
              />
              <button type="button" className="secondary-button" disabled={busy} onClick={() => void act(() => cancelSecretAudit(csrfToken))}>
                {busy ? 'Cancelling…' : 'Cancel audit'}
              </button>
            </div>
          ) : (
            <form
              className="form-stack"
              onSubmit={(event) => {
                event.preventDefault();
                if (busy || !acknowledged || snapshot.packId === undefined || snapshot.toolId === undefined) return;
                setFilter('');
                setCopied('');
                void act(async () => {
                  const next = await startSecretAudit(csrfToken, {
                    packId: snapshot.packId!, toolId: snapshot.toolId!,
                    minimumConfidence: scanType === 'references' ? minimum : 'high',
                    applianceUrl: (applianceURL ?? snapshot.target?.applianceUrl ?? '').trim(),
                    scanType,
                    ...(scanType !== 'references' ? { pattern } : {}),
                  });
                  setPattern('');
                  setAcknowledged(false);
                  return next;
                });
              }}
            >
              <label className="field">
                <span>CyberArk backend URL</span>
                <input type="url" name="audit-backend-url" required maxLength={2048} autoComplete="off" spellCheck={false}
                  placeholder="https://conjur.example.com" aria-describedby="audit-backend-help"
                  value={applianceURL ?? snapshot.target?.applianceUrl ?? ''} disabled={busy}
                  onChange={(event) => { setApplianceURL(event.target.value); setAcknowledged(false); }} />
              </label>
              <p id="audit-backend-help" className="field-help">
                Uses the Conjur CLI session for this backend and account. To use another backend, configure
                your Conjur CLI for it first, then sign in.
              </p>
              <div className="secret-audit-actions">
                <button type="button" className="secondary-button" disabled={busy} onClick={onOpenAuthentication}>Connection and sign-in</button>
              </div>
              <label className="field">
                <span>Secret value scan</span>
                <select name="audit-scan-type" value={scanType} disabled={busy} onChange={(event) => {
                  setScanType(event.target.value as SecretAuditScanType);
                  setPattern('');
                  setAcknowledged(false);
                }}>
                  {Object.entries(scanTypeText).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
              {scanType !== 'references' && (
                <>
                  <label className="field">
                    <span>{scanType === 'regex' ? 'Value pattern' : 'Text to match'}</span>
                    <input type="text" name="audit-pattern" required maxLength={1024} value={pattern} disabled={busy}
                      autoComplete="off" spellCheck={false} aria-describedby="audit-pattern-help"
                      placeholder={scanType === 'regex' ? '^team[./].*/password$' : undefined}
                      onChange={(event) => { setPattern(event.target.value); setAcknowledged(false); }} />
                  </label>
                  <p id="audit-pattern-help" className="field-help">
                    {scanType === 'regex'
                      ? 'Use a Go regular expression for paths or other value shapes. Add ^ and $ to match the entire value; (?i) makes it case-insensitive.'
                      : 'Text matching is case-sensitive and preserves spaces.'}
                    {' '}Only matching variable IDs are returned. Scan text is cleared after starting and excluded from reports.
                  </p>
                </>
              )}
              {scanType === 'references' && <fieldset className="field-group secret-audit-choice">
                <legend>What to report</legend>
                <label className="checkbox-row">
                  <input type="radio" name="minimum" checked={minimum === 'medium'} disabled={busy}
                    onChange={() => { setMinimum('medium'); setAcknowledged(false); }} />
                  <span>
                    <strong>Likely and possible references</strong> (recommended)
                    <small>Also includes paths that only look like references, so review each one.</small>
                  </span>
                </label>
                <label className="checkbox-row">
                  <input type="radio" name="minimum" checked={minimum === 'high'} disabled={busy}
                    onChange={() => { setMinimum('high'); setAcknowledged(false); }} />
                  <span>
                    <strong>Likely references only</strong>
                    <small>Only values that match another variable or use a conjur:// style reference.</small>
                  </span>
                </label>
              </fieldset>}

              <label className="checkbox-row secret-audit-ack">
                <input type="checkbox" checked={acknowledged} disabled={busy} onChange={(event) => setAcknowledged(event.target.checked)} />
                <span>
                  I’m authorized to read every variable this identity can see. Conjur records each read in its audit log.
                </span>
              </label>

              <div className="secret-audit-actions">
                <button type="submit" disabled={!acknowledged || busy || !(applianceURL ?? snapshot.target?.applianceUrl) || (scanType !== 'references' && pattern === '')}>
                  {busy ? 'Starting…' : completed || snapshot.state !== 'idle' ? 'Run audit again' : 'Start read-only audit'}
                </button>
              </div>
            </form>
          )}

          {failure && (
            <div className="failure-notice" role="alert">
              <strong>{failure.message}</strong>
              {failure.remediation && <p>{failure.remediation}</p>}
            </div>
          )}
        </article>

        {snapshot.state !== 'idle' && !running && (
          <article className="panel secret-audit-results" aria-labelledby="secret-audit-result-heading">
            <p className="status-label">Result</p>
            <h3 id="secret-audit-result-heading" ref={resultHeadingRef} tabIndex={-1}>
              {snapshot.state === 'cancelled' && 'Audit cancelled'}
              {auditFailure?.title}
              {completed &&
                (snapshot.findings.length === 0
                  ? snapshot.failures.length === 0
                    ? 'No values matched the selected scan'
                    : 'No readable values matched the selected scan'
                  : `${snapshot.findings.length.toLocaleString()} ${snapshot.findings.length === 1 ? 'variable needs' : 'variables need'} review`)}
            </h3>

            {snapshot.state === 'cancelled' && <p>No partial results are kept. Run the audit again when you’re ready.</p>}

            {auditFailure && (
              <div className="failure-notice">
                <p>{auditFailure.detail}</p>
                {auditFailure.action === 'authentication' && (
                  <button type="button" onClick={onOpenAuthentication}>Open Authentication</button>
                )}
                {auditFailure.action === 'diagnostics' && (
                  <button type="button" className="secondary-button" onClick={onOpenDiagnostics}>Open Diagnostics</button>
                )}
              </div>
            )}

            {completed && (
              <>
                <dl className="runtime-facts secret-audit-summary" aria-label="Audit summary">
                  <div>
                    <dt>Scan</dt>
                    <dd>{scanTypeText[snapshot.scanType ?? 'references']}</dd>
                  </div>
                  <div>
                    <dt>Variables</dt>
                    <dd>{snapshot.total.toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>Checked</dt>
                    <dd>{snapshot.inspected.toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>To review</dt>
                    <dd>{snapshot.findings.length.toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>Not readable</dt>
                    <dd>{snapshot.failures.length.toLocaleString()}</dd>
                  </div>
                </dl>

                <div className="secret-audit-actions">
                  <button type="button" className="secondary-button" onClick={() => downloadReport(snapshot)}>
                    Download redacted report
                  </button>
                  {snapshot.findings.length > 0 && (
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => void copy('all', snapshot.findings.map((finding) => finding.variableId).join('\n'))}
                    >
                      Copy all flagged IDs
                    </button>
                  )}
                  <span className="structured-copy-status" role="status">
                    {copied === 'all' ? 'Flagged IDs copied.' : copied ? `Copied ${copied}.` : ''}
                  </span>
                </div>

                {snapshot.findings.length > 0 && (
                  <section aria-labelledby="secret-audit-findings-heading">
                    <h4 id="secret-audit-findings-heading">Values to review</h4>
                    <p className="field-help">
                      These are heuristics, not proof. Check each value with the owning team, then put the real secret
                      in place through your approved change process. CLIHarbor never changes variables.
                    </p>
                    {snapshot.findings.length > 8 && (
                      <label className="task-search secret-audit-filter">
                        <span className="task-search-label">Filter by variable ID</span>
                        <input
                          type="search"
                          value={filter}
                          placeholder="e.g. prod/app"
                          onChange={(event) => setFilter(event.target.value)}
                        />
                      </label>
                    )}
                    <ul className="secret-audit-list">
                      {visibleFindings.map((finding) => (
                        <li key={finding.variableId}>
                          <div>
                            <code>{finding.variableId}</code>
                            <p>{reasonText[finding.reason] ?? finding.reason}</p>
                          </div>
                          <span className={'secret-audit-badge secret-audit-badge--' + finding.confidence}>
                            {snapshot.scanType && snapshot.scanType !== 'references' ? 'Matched' : finding.confidence === 'high' ? 'Likely' : 'Possible'}
                          </span>
                          <button
                            type="button"
                            className="secondary-button structured-copy-button"
                            aria-label={`Copy variable ID ${finding.variableId}`}
                            onClick={() => void copy(finding.variableId, finding.variableId)}
                          >
                            Copy ID
                          </button>
                        </li>
                      ))}
                    </ul>
                    {visibleFindings.length === 0 && <p className="task-search-empty">No flagged variable matches “{filter}”.</p>}
                  </section>
                )}

                {snapshot.failures.length > 0 && (
                  <details className="technical-details secret-audit-failures">
                    <summary>
                      {snapshot.failures.length.toLocaleString()} {snapshot.failures.length === 1 ? 'variable' : 'variables'} could not be checked
                    </summary>
                    <ul className="secret-audit-list">
                      {snapshot.failures.map((item) => (
                        <li key={item.variableId}>
                          <div>
                            <code>{item.variableId}</code>
                            <p>{failureCodeText[item.code] ?? item.code}</p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </>
            )}
          </article>
        )}
      </div>
    </section>
  );
}

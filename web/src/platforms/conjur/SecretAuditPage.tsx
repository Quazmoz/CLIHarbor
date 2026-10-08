import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { normalizeError, type AppErrorDetail } from '../../api/errors';
import {
  cancelSecretAudit,
  fetchSecretAudit,
  startSecretAudit,
  type SecretAuditConfidence,
  type SecretAuditScanType,
  type SecretAuditSnapshot,
} from './secretAuditApi';

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
  regex_variable_id_match: 'Variable ID matches the specified regular expression (no secret value was retrieved).',
};

const scanTypeText: Record<SecretAuditScanType, string> = {
  references: 'Secret references and paths',
  contains: 'Contains text',
  exact: 'Exact text',
  regex: 'Secret values · regex (reads values)',
  'id-regex': 'Variable IDs · regex (metadata only)',
};


interface ScanPreset {
  id: string;
  label: string;
  description: string;
  mode: 'id-regex' | 'regex';
  pattern: string;
}

// Examples are syntactic filters, not vulnerability or secret-exposure verdicts.
// RE2-compatible expressions; never insert server-supplied patterns into this list.
const scanPresets: ScanPreset[] = [
  { id: 'credential-names', label: 'Credential-like names', mode: 'id-regex',
    description: 'Paths containing password, token, API key or secret field names.',
    pattern: '(?i)(?:^|[/._-])(?:password|passwd|token|api[_-]?key|secret|credential)(?:$|[/._-])' },
  { id: 'production', label: 'Production paths', mode: 'id-regex',
    description: 'IDs labeled prod or production, across folders and separators.',
    pattern: '(?i)(?:^|[/._-])(?:prod|production)(?:$|[/._-])' },
  { id: 'service-accounts', label: 'Service-account paths', mode: 'id-regex',
    description: 'IDs identifying service, automation or robot accounts.',
    pattern: '(?i)(?:^|[/._-])(?:svc|service[_-]?account|robot|automation)(?:$|[/._-])' },
  { id: 'legacy', label: 'Legacy paths', mode: 'id-regex',
    description: 'IDs labeled old, deprecated, retired or legacy.',
    pattern: '(?i)(?:^|[/._-])(?:legacy|deprecated|retired|old)(?:$|[/._-])' },
  { id: 'reference-values', label: 'Reference URI values', mode: 'regex',
    description: 'Values that resemble Conjur/CyberArk/Idira reference URLs; requires executing secrets.',
    pattern: '(?i)^(?:conjur|cyberark|idira)://[^\\s]+$' },
  { id: 'pem-values', label: 'PEM header values', mode: 'regex',
    description: 'Values containing PEM BEGIN markers; requires executing secrets.',
    pattern: '-----BEGIN (?:[A-Z ]+ )?(?:PRIVATE KEY|CERTIFICATE)-----' },
];

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
  const [scanType, setScanType] = useState<'id-regex' | 'regex'>('id-regex');
  const [pattern, setPattern] = useState(scanPresets[0].pattern);
  const [presetID, setPresetID] = useState(scanPresets[0].id);
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
      <h2 id="secret-audit-heading">Conjur pattern explorer</h2>
      <p>Search Conjur variable IDs using a regex preset or custom expression without reading secret values.
        Optional secret-value regex matching is separately selected and acknowledged. Results contain IDs and reason codes,
        not secret values or matching excerpts. A match is not a security verdict.</p>
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
          <h3 id="secret-audit-setup-heading">{running ? 'Search running' : 'Search patterns'}</h3>

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
              <dd>{scanType === 'id-regex' ? 'Visible variable IDs · metadata only' : 'All readable values · explicit access'}</dd>
            </div>
          </dl>

          {running ? (
            <div className="secret-audit-progress">
              {/* Announce phase changes only; the count updates every poll and would be noisy. */}
              <p role="status" aria-live="polite">{phaseText[snapshot.phase ?? ''] ?? 'Working'}</p>
              {(snapshot.phase === 'reading' || snapshot.phase === 'matching') && (
                <p aria-hidden="true">
                  {snapshot.processed.toLocaleString()} of {snapshot.total.toLocaleString()} variables
                </p>
              )}
              <progress
                max={100}
                value={snapshot.phase === 'reading' || snapshot.phase === 'matching' || snapshot.phase === 'verifying' ? percent : undefined}
                aria-label="Audit progress"
                aria-valuetext={snapshot.phase === 'reading' || snapshot.phase === 'matching' ? `${snapshot.processed} of ${snapshot.total} variables` : undefined}
              />
              <button type="button" className="secondary-button" disabled={busy} onClick={() => void act(() => cancelSecretAudit(csrfToken))}>
                {busy ? 'Cancelling…' : 'Cancel search'}
              </button>
            </div>
          ) : (
            <form
              className="form-stack"
              onSubmit={(event) => {
                event.preventDefault();
                if (busy || !acknowledged || !pattern || snapshot.packId === undefined || snapshot.toolId === undefined) return;
                setFilter('');
                setCopied('');
                void act(async () => {
                  const next = await startSecretAudit(csrfToken, {
                    packId: snapshot.packId!, toolId: snapshot.toolId!,
                    minimumConfidence: 'high',
                    applianceUrl: (applianceURL ?? snapshot.target?.applianceUrl ?? '').trim(),
                    scanType,
                    pattern,
                  });
                  setPattern('');
                  setPresetID('custom');
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
                <span>Search target</span>
                <select name="audit-scan-type" value={scanType} disabled={busy} onChange={(event) => {
                  const mode = event.target.value as 'id-regex' | 'regex';
                  setScanType(mode);
                  const suggested = scanPresets.find((preset) => preset.mode === mode);
                  setPattern(suggested?.pattern ?? '');
                  setPresetID(suggested?.id ?? 'custom');
                  setAcknowledged(false);
                }}>
                  <option value="id-regex">{scanTypeText['id-regex']}</option>
                  <option value="regex">{scanTypeText.regex}</option>
                </select>
              </label>
              <p className="field-help">{scanType === 'id-regex'
                ? 'Searches only inventory IDs. No secret values are fetched and execute privilege is not required.'
                : 'Sensitive: retrieves readable secret values into backend memory. Each read may be audited by Conjur. No matching content is returned.'}</p>
              <label className="field">
                <span>Pattern preset</span>
                <select name="audit-preset" value={presetID} disabled={busy} onChange={(event) => {
                  const preset = scanPresets.find((candidate) => candidate.mode === scanType && candidate.id === event.target.value);
                  setPresetID(preset?.id ?? 'custom');
                  setPattern(preset?.pattern ?? '');
                  setAcknowledged(false);
                }}>
                  <option value="custom">Custom expression</option>
                  {scanPresets.filter((preset) => preset.mode === scanType).map((preset) =>
                    <option key={preset.id} value={preset.id}>{preset.label}</option>)}
                </select>
              </label>
              {presetID !== 'custom' && <p className="field-help">{scanPresets.find((preset) => preset.id === presetID)?.description}</p>}
              <label className="field">
                <span>Regex pattern (Go / RE2)</span>
                <input type="text" name="audit-pattern" required maxLength={1024} value={pattern} disabled={busy}
                  autoComplete="off" spellCheck={false} aria-describedby="audit-pattern-help"
                  placeholder="(?i)(?:^|/)prod(?:/|$)"
                  onChange={(event) => { setPattern(event.target.value); setPresetID('custom'); setAcknowledged(false); }} />
              </label>
              <p id="audit-pattern-help" className="field-help">
                RE2 syntax: ^ and $ anchor matches, (?i) ignores case. Lookarounds and backreferences are unsupported.
                Editing a preset creates a custom expression. Criteria are cleared after submission and excluded from reports.
              </p>
              <label className="checkbox-row secret-audit-ack">
                <input type="checkbox" checked={acknowledged} disabled={busy} onChange={(event) => setAcknowledged(event.target.checked)} />
                <span>
                  {scanType === 'id-regex'
                    ? 'I’m authorized to inspect visible Conjur variable identifiers.'
                    : 'I’m authorized to read every variable this identity can execute. Conjur records each read in its audit log.'}
                </span>
              </label>

              <div className="secret-audit-actions">
                <button type="submit" disabled={!acknowledged || busy || !(applianceURL ?? snapshot.target?.applianceUrl) || pattern === ''}>
                  {busy ? 'Starting…' : completed || snapshot.state !== 'idle' ? 'Search again' : 'Start pattern search'}
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
              {snapshot.state === 'cancelled' && 'Search cancelled'}
              {auditFailure?.title}
              {completed &&
                (snapshot.findings.length === 0
                  ? snapshot.failures.length === 0
                    ? 'No variables matched the pattern'
                    : 'No readable values matched the pattern'
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
                    <h4 id="secret-audit-findings-heading">Matching variables</h4>
                    <p className="field-help">
                      Matches are search results, not security verdicts. CLIHarbor never changes variables or reveals matching values.
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

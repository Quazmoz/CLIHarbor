import { useEffect, useMemo, useRef, useState } from 'react';
import { normalizeError, type AppErrorDetail } from './api/errors';
import {
  cancelRun,
  decodeRunOutput,
  fetchRun,
  fetchRuns,
  type RunSnapshot,
  type RunStatus,
  type RunSummary,
} from './api/runs';
import type { Task } from './api/tasks';
import { runOutcomeHeading, runOutcomeTone } from './operatorLanguage';
import { OutputExplorer } from './OutputExplorer';
import { MutationAuditTrail } from './MutationAuditTrail';
import { RunComparison } from './RunComparison';

interface RunsPageProps {
  tasks: Task[];
  csrfToken?: string;
  tasksLocked?: boolean;
  onConfigureTask?: (task: Task) => void;
  onOpenTasks?: () => void;
  onSelectRun?: (runId: string) => void;
  requestedRun?: { runId: string };
}

function HistoryCancellation({ run, csrfToken, onReconcile }: { run: RunSnapshot; csrfToken: string; onReconcile: () => void }) {
  const [phase, setPhase] = useState<'idle' | 'requesting' | 'requested'>('idle');
  const [failure, setFailure] = useState<AppErrorDetail | null>(null);
  const pending = useRef(false);
  const alive = useRef(true);
  const region = useRef<HTMLDivElement>(null);
  const focused = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    if ((run.status !== 'running' || failure !== null) && focused.current &&
        (document.activeElement === document.body || region.current?.contains(document.activeElement))) {
      region.current?.focus();
      focused.current = false;
    }
  }, [run.status, failure]);
  const cancel = async () => {
    if (pending.current || phase !== 'idle' || run.status !== 'running') return;
    pending.current = true;
    setPhase('requesting');
    setFailure(null);
    try {
      await cancelRun(csrfToken, run.runId);
      if (alive.current) setPhase('requested');
    } catch (error) {
      if (alive.current) {
        setFailure(normalizeError(error).detail);
        setPhase('idle');
      }
    } finally {
      pending.current = false;
      // Read the final outcome; a cancellation acknowledgement is not completion evidence.
      if (alive.current) onReconcile();
    }
  };
  return <div ref={region} tabIndex={-1} aria-label="Run cancellation">
    {run.status === 'running' ? <>
      <button type="button" className="secondary-button" disabled={phase !== 'idle'} aria-busy={phase === 'requesting'}
        onFocus={() => { focused.current = true; }} onBlur={(event) => {
          if (event.relatedTarget && !region.current?.contains(event.relatedTarget)) focused.current = false;
        }}
        onClick={() => void cancel()}>{phase === 'requesting' ? 'Requesting cancellation…' : phase === 'requested' ? 'Cancellation requested' : 'Cancel this run'}</button>
      <p className="overview-hint">Cancellation stops local execution. Vendor changes may already have happened; inspect the target before another attempt.</p>
      {phase !== 'idle' && <p role="status">{phase === 'requesting' ? 'Sending cancellation request…' : 'Cancellation requested. Waiting for the final run outcome.'}</p>}
      {failure && <><FailureNotice failure={failure} /><p>Cancellation is unconfirmed. Live history checks continue when available; refresh this run to verify its outcome.</p></>}
    </> : phase !== 'idle' ? <span className="summary-meta">Run finished: {statusText(run.status, run.exitCode)}.</span> : null}
  </div>;
}

const ACTIVE_RUN_REFRESH_MS = 2000;

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function taskName(run: Pick<RunSummary, 'packId' | 'commandId'>, tasks: Task[]): string {
  return (
    tasks.find((task) => task.packId === run.packId && task.commandId === run.commandId)?.name ??
    run.commandId
  );
}

function statusText(status: RunStatus, exitCode?: number): string {
  return runOutcomeHeading(status, exitCode);
}

export function formatTimestamp(value?: string): string {
  if (value === undefined) {
    return 'Not started';
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return 'Time unavailable';
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(date);
}

export function formatDuration(startedAt?: string, endedAt?: string): string {
  if (startedAt === undefined) {
    return '—';
  }
  const start = new Date(startedAt).getTime();
  const end = endedAt === undefined ? Date.now() : new Date(endedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return '—';
  }
  const milliseconds = end - start;
  if (milliseconds < 1000) {
    return String(milliseconds) + ' ms';
  }
  if (milliseconds < 60_000) {
    return (milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0) + ' s';
  }
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1000);
  return String(minutes) + 'm ' + String(seconds) + 's';
}

function FailureNotice({ failure }: { failure: AppErrorDetail }) {
  return (
    <div className="failure-notice" role="alert">
      <strong>{failure.message}</strong>
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

export function RunsPage({ tasks, csrfToken, tasksLocked = false, onConfigureTask, onOpenTasks, onSelectRun, requestedRun }: RunsPageProps) {
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const [summaries, setSummaries] = useState<RunSummary[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listFailure, setListFailure] = useState<AppErrorDetail | null>(null);
  const [listRefresh, setListRefresh] = useState(0);
  const [query, setQuery] = useState('');
  const [outcome, setOutcome] = useState('all');
  const [toolFilter, setToolFilter] = useState('all');
  const searchRef = useRef<HTMLInputElement>(null);
  const [selectedRunID, setSelectedRunID] = useState<string | null>(requestedRun?.runId ?? null);
  const [seenRequest, setSeenRequest] = useState(requestedRun);
  const [detail, setDetail] = useState<RunSnapshot | null>(null);
  const [comparisonBaseline, setComparisonBaseline] = useState<RunSnapshot | null>(null);
  const [detailLoading, setDetailLoading] = useState(requestedRun !== undefined);
  const [detailFailure, setDetailFailure] = useState<AppErrorDetail | null>(null);
  const [detailRefresh, setDetailRefresh] = useState(0);
  if (seenRequest !== requestedRun) {
    setSeenRequest(requestedRun);
    if ((requestedRun?.runId ?? null) !== selectedRunID) {
      setSelectedRunID(requestedRun?.runId ?? null);
      setDetail(null);
      setDetailFailure(null);
      setDetailLoading(requestedRun !== undefined);
    }
  }
  const listRequestRef = useRef<AbortController | null>(null);
  const detailRequestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    listRequestRef.current = controller;
    void fetchRuns(controller.signal).then(
      (runs) => {
        if (controller.signal.aborted) return;
        setSummaries(runs);
        setComparisonBaseline((current) => current && runs.some((run) => run.runId === current.runId) ? current : null);
        setListFailure(null);
        setListLoading(false);
      },
      (error: unknown) => {
        if (controller.signal.aborted || isAbort(error)) {
          return;
        }
        setListFailure(normalizeError(error).detail);
        setListLoading(false);
      },
    ).finally(() => {
      if (listRequestRef.current === controller) listRequestRef.current = null;
    });
    return () => {
      controller.abort();
      if (listRequestRef.current === controller) listRequestRef.current = null;
    };
  }, [listRefresh]);

  useEffect(() => {
    if (selectedRunID === null) {
      return;
    }

    const controller = new AbortController();
    detailRequestRef.current = controller;
    void fetchRun(selectedRunID, controller.signal).then(
      (snapshot) => {
        if (controller.signal.aborted) return;
        setDetail(snapshot);
        setDetailFailure(null);
        setDetailLoading(false);
      },
      (error: unknown) => {
        if (controller.signal.aborted || isAbort(error)) {
          return;
        }
        const failure = normalizeError(error).detail;
        if (failure.code === 'run_not_found') {
          setDetail(null);
          setComparisonBaseline((current) => current?.runId === selectedRunID ? null : current);
        }
        setDetailFailure(failure);
        setDetailLoading(false);
      },
    ).finally(() => {
      if (detailRequestRef.current === controller) detailRequestRef.current = null;
    });
    return () => {
      controller.abort();
      if (detailRequestRef.current === controller) detailRequestRef.current = null;
    };
  }, [detailRefresh, selectedRunID]);

  const selectedSummary = useMemo(
    () => summaries.find((summary) => summary.runId === selectedRunID),
    [selectedRunID, summaries],
  );
  const refreshList = summaries.some((summary) => summary.status === 'running') && listFailure?.retryable !== false;
  const refreshDetail = detail?.status === 'running' && detailFailure?.retryable !== false;

  useEffect(() => {
    if (!refreshList && !refreshDetail) {
      return;
    }

    const refreshActiveRuns = () => {
      if (document.visibilityState !== 'visible') {
        return;
      }
      if (refreshList && listRequestRef.current === null) setListRefresh((value) => value + 1);
      if (refreshDetail && selectedRunID !== null && detailRequestRef.current === null) {
        setDetailRefresh((value) => value + 1);
      }
    };

    const intervalID = window.setInterval(refreshActiveRuns, ACTIVE_RUN_REFRESH_MS);
    document.addEventListener('visibilitychange', refreshActiveRuns);
    return () => {
      window.clearInterval(intervalID);
      document.removeEventListener('visibilitychange', refreshActiveRuns);
    };
  }, [refreshList, refreshDetail, selectedRunID]);

  const refresh = () => {
    setListLoading(true);
    setListFailure(null);
    setListRefresh((value) => value + 1);
    if (selectedRunID !== null) {
      setDetailLoading(true);
      setDetailFailure(null);
      setDetailRefresh((value) => value + 1);
    }
  };

  const selectRun = (runID: string) => {
    if (runID === selectedRunID) return;
    if (onSelectRun) { onSelectRun(runID); return; }
    setSelectedRunID(runID);
    setDetail(null);
    setDetailFailure(null);
    setDetailLoading(true);
  };

  // On narrow screens the detail sits far below the list; move focus (and the view) to it.
  useEffect(() => {
    if (selectedRunID !== null) detailHeadingRef.current?.focus();
  }, [selectedRunID]);

  const refreshRun = () => {
    if (selectedRunID === null) {
      return;
    }
    setDetailLoading(true);
    setDetailFailure(null);
    setDetailRefresh((value) => value + 1);
  };

  const output = useMemo(() => detail === null ? { stdout: '', stderr: '' } : {
    stdout: decodeRunOutput(detail, 'stdout.chunk'),
    stderr: decodeRunOutput(detail, 'stderr.chunk'),
  }, [detail]);

  // Keep an evicted CLI selectable until the operator clears its filter.
  const historyTools = [...new Set([
    ...summaries.map((run) => run.packId + '/' + run.toolId),
    ...(toolFilter === 'all' ? [] : [toolFilter]),
  ])].sort();
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const visibleRuns = summaries.filter((run) => {
    const tone = runOutcomeTone(run.status, run.exitCode);
    if (outcome !== 'all' && tone !== outcome) return false;
    if (toolFilter !== 'all' && run.packId + '/' + run.toolId !== toolFilter) return false;
    const task = tasks.find((task) => task.packId === run.packId && task.commandId === run.commandId);
    const text = [task?.name, task?.packName, run.packId, run.commandId, run.toolId,
      run.toolVersion, run.runId, statusText(run.status, run.exitCode)].join(' ').toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
  const clearFilters = () => {
    setQuery('');
    setOutcome('all');
    setToolFilter('all');
    searchRef.current?.focus();
  };
  const selectedTask = detail && tasks.find((task) => task.packId === detail.packId && task.commandId === detail.commandId && task.toolId === detail.toolId);

  return (
    <section className="runs-page" aria-labelledby="runs-heading">
      <div className="route-heading route-heading--actions">
        <div>
          <h2 id="runs-heading">Execution History</h2>
          <p>Runs from this CLIHarbor process. Active runs refresh automatically; history clears when CLIHarbor restarts.</p>
        </div>
        <button type="button" className="secondary-button" disabled={listLoading} onClick={refresh}>
          {listLoading ? 'Refreshing…' : 'Refresh history'}
        </button>
      </div>

      <div className="run-history-layout">
        <article className="panel run-history-list-panel" aria-labelledby="run-history-list-heading" aria-busy={listLoading}>
          <div className="panel-heading-row">
            <h3 id="run-history-list-heading">Runs</h3>
            <span className="summary-meta">{summaries.length} retained</span>
          </div>

          {summaries.length > 0 && <div className="run-history-filters">
            <label className="structured-result-control">
              <span>Search runs</span>
              <input ref={searchRef} type="search" value={query} maxLength={256}
                placeholder="Task, CLI, run ID, or outcome"
                onChange={(event) => setQuery(event.target.value)} />
            </label>
            <div className="run-history-filter-selects">
              <label className="structured-result-control">
                <span>Outcome</span>
                <select value={outcome} onChange={(event) => setOutcome(event.target.value)}>
                  <option value="all">All outcomes</option>
                  <option value="running">Running</option>
                  <option value="succeeded">Succeeded</option>
                  <option value="failed">Failed</option>
                  <option value="cancelled">Cancelled</option>
                  <option value="timed-out">Timed out</option>
                </select>
              </label>
              <label className="structured-result-control">
                <span>CLI</span>
                <select value={toolFilter} onChange={(event) => setToolFilter(event.target.value)}>
                  <option value="all">All CLIs</option>
                  {historyTools.map((tool) => (
                    <option key={tool} value={tool}>{tool}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="panel-heading-row">
              <span className="summary-meta" role="status">{visibleRuns.length} of {summaries.length} runs</span>
              <button type="button" className="link-button" disabled={!query && outcome === 'all' && toolFilter === 'all'} onClick={clearFilters}>Clear filters</button>
            </div>
          </div>}

          {comparisonBaseline && (
            <div className="run-comparison-pin">
              <p role="status">Baseline: {taskName(comparisonBaseline, tasks)} <code>{comparisonBaseline.runId}</code></p>
              <button type="button" className="secondary-button" onClick={() => {
                setComparisonBaseline(null);
                detailHeadingRef.current?.focus();
              }}>Clear comparison</button>
            </div>
          )}

          {listFailure !== null && <FailureNotice failure={listFailure} />}
          {listLoading && summaries.length === 0 && <p role="status">Loading retained runs…</p>}

          {!listLoading && listFailure === null && summaries.length === 0 && (
            <div className="empty-state">
              <strong>No retained runs yet.</strong>
              <p>Run a safe task and it will appear here for the lifetime of this CLIHarbor process.</p>
              {onOpenTasks && (
                <button type="button" onClick={onOpenTasks}>
                  Open tasks
                </button>
              )}
            </div>
          )}

          {summaries.length > 0 && (
            <ol className="run-history-list">
              {visibleRuns.map((summary) => (
                <li key={summary.runId}>
                  <button
                    type="button"
                    className="run-history-entry"
                    aria-pressed={selectedRunID === summary.runId}
                    onClick={() => selectRun(summary.runId)}
                  >
                    <span className="run-history-entry-main">
                      <strong>{taskName(summary, tasks)}</strong>
                      <span>
                        {summary.packId} · {summary.toolId}
                        {summary.toolVersion ? ' ' + summary.toolVersion : ''}
                      </span>
                    </span>
                    <span className="run-history-entry-meta">
                      <span className={'run-history-status run-history-status--' + runOutcomeTone(summary.status, summary.exitCode)}>
                        {statusText(summary.status, summary.exitCode)}
                      </span>
                      <span>{formatTimestamp(summary.startedAt)}</span>
                      <code className="summary-meta" title={summary.runId}>Run {summary.runId.slice(0, 8)}</code>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
          {summaries.length > 0 && visibleRuns.length === 0 && (
            <p className="empty-state">No retained runs match these filters. Clear filters to see all retained runs.</p>
          )}
        </article>

        {(summaries.length > 0 || selectedRunID !== null) && (
        <article className="panel run-history-detail-panel" aria-labelledby="run-history-detail-heading" aria-busy={detailLoading}>
          <p className="status-label">Run detail</p>
          {selectedRunID === null ? (
            <div className="empty-state run-history-detail-empty">
              <h3 id="run-history-detail-heading">Select a run</h3>
              <p>
                History summaries contain metadata only. Opening a run fetches its retained structured result and raw process
                evidence from the existing single-run endpoint.
              </p>
            </div>
          ) : (
            <>
              <div className="panel-heading-row">
                <div>
                  <h3 id="run-history-detail-heading" ref={detailHeadingRef} tabIndex={-1}>
                    {selectedSummary ? taskName(selectedSummary, tasks) : 'Retained run'}
                  </h3>
                  <p className="run-history-id">{selectedRunID}</p>
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={detailLoading}
                  onClick={refreshRun}
                >
                  {detailLoading ? 'Refreshing…' : 'Refresh run'}
                </button>
              </div>

              {detailFailure !== null && <FailureNotice failure={detailFailure} />}
              {selectedSummary && !visibleRuns.some((run) => run.runId === selectedRunID) && (
                <p>The selected run is outside the current list filters.</p>
              )}
              {detailLoading && detail === null && <p role="status">Loading run evidence…</p>}

              {detail !== null && (
                <>
                  <dl className="run-meta run-history-meta" aria-label="Run summary">
                    <div>
                      <dt>Status</dt>
                      <dd>{statusText(detail.status, detail.exitCode)}</dd>
                    </div>
                    <div>
                      <dt>Started</dt>
                      <dd>{formatTimestamp(detail.startedAt)}</dd>
                    </div>
                    <div>
                      <dt>Duration</dt>
                      <dd>{formatDuration(detail.startedAt, detail.endedAt)}</dd>
                    </div>
                    <div>
                      <dt>Exit code</dt>
                      <dd>{detail.exitCode ?? '—'}</dd>
                    </div>
                    <div>
                      <dt>Tool</dt>
                      <dd>
                        {detail.toolId}
                        {detail.toolVersion ? ' ' + detail.toolVersion : ''}
                      </dd>
                    </div>
                  </dl>

                  {csrfToken && <HistoryCancellation key={detail.runId} run={detail} csrfToken={csrfToken} onReconcile={() => {
                    setListRefresh((value) => value + 1);
                    setDetailRefresh((value) => value + 1);
                  }} />}
                  {onConfigureTask && detail.status !== 'running' && <div className="run-history-task-action">
                    <button type="button" className="secondary-button" disabled={!selectedTask || tasksLocked || detailFailure !== null}
                      onClick={() => { if (selectedTask) onConfigureTask(selectedTask); }}>Configure this task</button>
                    <p className="overview-hint">{selectedTask ? 'Opens a fresh form with current defaults. Review inputs and approvals before running.' : 'This task is no longer available in the current CLI catalog.'}</p>
                  </div>}

                  <button type="button" className="secondary-button"
                    disabled={detail.status === 'running' || detailLoading || detailFailure !== null || listLoading || listFailure !== null || !selectedSummary || comparisonBaseline?.runId === detail.runId}
                    onClick={() => setComparisonBaseline(detail)}>Pin for comparison</button>
                  {comparisonBaseline && <RunComparison baseline={comparisonBaseline} selected={detail} />}

                  {detail.failure && <FailureNotice failure={detail.failure} />}

                  {detail.structured && <h3 className="structured-result-heading">Structured result</h3>}
                  {detail.structured?.status === 'invalid' && (
                    <p className="parser-warning" role="status">Structured result validation failed. Inspect raw output for the original evidence.</p>
                  )}
                  <OutputExplorer key={detail.runId}
                    runId={detail.runId}
                    stdout={output.stdout} stderr={output.stderr}
                    structured={detail.structured} status={detail.status} exitCode={detail.exitCode}
                  />
                </>
              )}
            </>
          )}
        </article>
        )}
      </div>
      <MutationAuditTrail />
    </section>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { normalizeError, type AppErrorDetail } from './api/errors';
import {
  decodeRunOutput,
  fetchRun,
  fetchRuns,
  type RunSnapshot,
  type RunStatus,
  type RunSummary,
} from './api/runs';
import type { Task } from './api/tasks';
import { runOutcomeHeading, runOutcomeTone } from './operatorLanguage';
import { StructuredResultView } from './StructuredResultView';

interface RunsPageProps {
  tasks: Task[];
}

const ACTIVE_RUN_REFRESH_MS = 2000;

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function taskName(run: Pick<RunSummary, 'packId' | 'commandId'>, tasks: Task[]): string {
  return (
    tasks.find((task) => task.packId === run.packId && task.commandId === run.commandId)?.name ??
    run.commandId
  );
}

function statusText(status: RunStatus, exitCode?: number): string {
  return runOutcomeHeading(status, exitCode);
}

function formatTimestamp(value?: string): string {
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

function formatDuration(startedAt?: string, endedAt?: string): string {
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

export function RunsPage({ tasks }: RunsPageProps) {
  const [summaries, setSummaries] = useState<RunSummary[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listFailure, setListFailure] = useState<AppErrorDetail | null>(null);
  const [listRefresh, setListRefresh] = useState(0);
  const [selectedRunID, setSelectedRunID] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunSnapshot | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailFailure, setDetailFailure] = useState<AppErrorDetail | null>(null);
  const [detailRefresh, setDetailRefresh] = useState(0);
  const listRequestRef = useRef<AbortController | null>(null);
  const detailRequestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    listRequestRef.current = controller;
    void fetchRuns(controller.signal).then(
      (runs) => {
        if (controller.signal.aborted) return;
        setSummaries(runs);
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
        if (failure.code === 'run_not_found') setDetail(null);
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
    setSelectedRunID(runID);
    setDetail(null);
    setDetailFailure(null);
    setDetailLoading(true);
  };

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

  return (
    <section className="runs-page" aria-labelledby="runs-heading">
      <div className="route-heading route-heading--actions">
        <div>
          <p className="status-label">Local run history</p>
          <h2 id="runs-heading">Recent runs</h2>
          <p>
            Review bounded run metadata from this CLIHarbor process. Active runs refresh automatically while this page is
            visible. Restarting CLIHarbor clears this in-memory history.
          </p>
        </div>
        <button type="button" className="secondary-button" disabled={listLoading} onClick={refresh}>
          {listLoading ? 'Refreshing…' : 'Refresh history'}
        </button>
      </div>

      <div className="run-history-layout">
        <article className="panel run-history-list-panel" aria-labelledby="run-history-list-heading" aria-busy={listLoading}>
          <div className="panel-heading-row">
            <div>
              <p className="status-label">Retained</p>
              <h3 id="run-history-list-heading">Runs</h3>
            </div>
            <span className="summary-meta">{summaries.length} retained</span>
          </div>

          {listFailure !== null && <FailureNotice failure={listFailure} />}
          {listLoading && summaries.length === 0 && <p role="status">Loading retained runs…</p>}

          {!listLoading && listFailure === null && summaries.length === 0 && (
            <div className="empty-state">
              <strong>No retained runs yet.</strong>
              <p>Run a safe task and it will appear here for the lifetime of this CLIHarbor process.</p>
            </div>
          )}

          {summaries.length > 0 && (
            <ol className="run-history-list">
              {summaries.map((summary) => (
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
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </article>

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
                  <h3 id="run-history-detail-heading">
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

                  {detail.failure && <FailureNotice failure={detail.failure} />}

                  {detail.structured && (
                    <section className="structured-result" aria-labelledby="history-structured-heading">
                      <h3 id="history-structured-heading">Structured result</h3>
                      {detail.structured.status === 'available' ? (
                        <StructuredResultView fields={detail.structured.fields ?? []} />
                      ) : (
                        <p className="parser-warning">
                          Structured result status: <code>{detail.structured.status}</code>
                          {detail.structured.error ? (
                            <>
                              {' '}· <code>{detail.structured.error}</code>
                            </>
                          ) : null}
                          . Raw stdout and stderr remain available below.
                        </p>
                      )}
                    </section>
                  )}

                  <details className="raw-output" open={detail.structured?.status !== 'available'}>
                    <summary>
                      <span>Raw process output</span>
                      <span className="raw-output-note">loaded only for this selected run</span>
                    </summary>
                    <div className="output-grid">
                      <section aria-labelledby="history-stdout-heading">
                        <h3 id="history-stdout-heading">stdout</h3>
                        <pre tabIndex={0}>{output.stdout || 'No stdout retained.'}</pre>
                      </section>
                      <section aria-labelledby="history-stderr-heading">
                        <h3 id="history-stderr-heading">stderr</h3>
                        <pre tabIndex={0}>{output.stderr || 'No stderr retained.'}</pre>
                      </section>
                    </div>
                  </details>
                </>
              )}
            </>
          )}
        </article>
      </div>
    </section>
  );
}

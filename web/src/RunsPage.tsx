import { useEffect, useMemo, useState } from 'react';
import { normalizeError, type AppErrorDetail } from './api/errors';
import {
  decodeBase64Text,
  fetchRun,
  fetchRuns,
  type RunSnapshot,
  type RunStatus,
  type RunSummary,
} from './api/runs';
import type { Task } from './api/tasks';

interface RunsPageProps {
  tasks: Task[];
}

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
  switch (status) {
    case 'running':
      return 'Running';
    case 'cancelled':
      return 'Cancelled';
    case 'timed-out':
      return 'Timed out';
    case 'failed':
      return 'Failed';
    case 'exited':
      return exitCode === 0 ? 'Succeeded' : exitCode === undefined ? 'Exited' : 'Exited (' + exitCode + ')';
  }
  return 'Unknown';
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

function outputFor(snapshot: RunSnapshot, stream: 'stdout.chunk' | 'stderr.chunk'): string {
  let output = '';
  for (const event of snapshot.events ?? []) {
    if (event.type === stream && event.dataBase64 !== undefined) {
      output += decodeBase64Text(event.dataBase64);
    }
  }
  return output;
}

function FailureNotice({ failure }: { failure: AppErrorDetail }) {
  return (
    <div className="failure-notice" role="alert">
      <strong>{failure.message}</strong>
      {failure.remediation && <p className="remediation">{failure.remediation}</p>}
      <p className="error-code">
        Error code: <code>{failure.code}</code>
      </p>
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

  useEffect(() => {
    const controller = new AbortController();
    void fetchRuns(controller.signal).then(
      (runs) => {
        setSummaries(runs);
        setListLoading(false);
      },
      (error: unknown) => {
        if (isAbort(error)) {
          return;
        }
        setListFailure(normalizeError(error).detail);
        setListLoading(false);
      },
    );
    return () => controller.abort();
  }, [listRefresh]);

  useEffect(() => {
    if (selectedRunID === null) {
      return;
    }

    const controller = new AbortController();
    void fetchRun(selectedRunID, controller.signal).then(
      (snapshot) => {
        setDetail(snapshot);
        setDetailLoading(false);
      },
      (error: unknown) => {
        if (isAbort(error)) {
          return;
        }
        setDetail(null);
        setDetailFailure(normalizeError(error).detail);
        setDetailLoading(false);
      },
    );
    return () => controller.abort();
  }, [detailRefresh, selectedRunID]);

  const selectedSummary = useMemo(
    () => summaries.find((summary) => summary.runId === selectedRunID),
    [selectedRunID, summaries],
  );

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

  const stdout = detail === null ? '' : outputFor(detail, 'stdout.chunk');
  const stderr = detail === null ? '' : outputFor(detail, 'stderr.chunk');

  return (
    <section className="runs-page" aria-labelledby="runs-heading">
      <div className="route-heading route-heading--actions">
        <div>
          <p className="status-label">Local run history</p>
          <h2 id="runs-heading">Recent runs</h2>
          <p>
            Review bounded run metadata from this CLIHarbor process. Restarting CLIHarbor clears this in-memory history.
          </p>
        </div>
        <button type="button" className="secondary-button" disabled={listLoading} onClick={refresh}>
          {listLoading ? 'Refreshing…' : 'Refresh history'}
        </button>
      </div>

      <div className="run-history-layout">
        <article className="panel run-history-list-panel" aria-labelledby="run-history-list-heading">
          <div className="panel-heading-row">
            <div>
              <p className="status-label">Retained</p>
              <h3 id="run-history-list-heading">Runs</h3>
            </div>
            <span className="summary-meta">{summaries.length} retained</span>
          </div>

          {listFailure !== null && <FailureNotice failure={listFailure} />}

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
                      <span className={'run-history-status run-history-status--' + summary.status}>
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

        <article className="panel run-history-detail-panel" aria-labelledby="run-history-detail-heading">
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

              {detail !== null && (
                <>
                  <dl className="run-meta run-history-meta">
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
                        <dl className="structured-grid">
                          {(detail.structured.fields ?? []).map((field) => (
                            <div key={field.key} className="structured-card">
                              <dt>{field.label}</dt>
                              <dd>{field.present ? field.value : 'Not provided'}</dd>
                            </div>
                          ))}
                        </dl>
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
                        <pre tabIndex={0}>{stdout || 'No stdout retained.'}</pre>
                      </section>
                      <section aria-labelledby="history-stderr-heading">
                        <h3 id="history-stderr-heading">stderr</h3>
                        <pre tabIndex={0}>{stderr || 'No stderr retained.'}</pre>
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

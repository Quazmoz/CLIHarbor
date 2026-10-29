import { useEffect, useRef, useState } from 'react';
import { fetchDiagnosticReport, type DiagnosticReport } from './api/diagnostics';
import { normalizeError, type AppErrorDetail } from './api/errors';

export function SupportDiagnostics() {
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [failure, setFailure] = useState<AppErrorDetail | null>(null);
  const [notice, setNotice] = useState<{ report: DiagnosticReport; message: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => { request.current?.abort(); }, []);
  const prepare = async () => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setFailure(null);
    setNotice(null);
    try {
      const next = await fetchDiagnosticReport(controller.signal);
      if (!controller.signal.aborted) {
        setReport(next);
        setNotice({ report: next, message: 'Diagnostics ready to review. Copy or download the report.' });
      }
    } catch (error) {
      if (!controller.signal.aborted) setFailure(normalizeError(error).detail);
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) setLoading(false);
    }
  };
  const copy = async () => {
    if (!report || loading || failure) return;
    try {
      await navigator.clipboard.writeText(report.json);
      setNotice({ report, message: 'Copied support diagnostics.' });
    } catch {
      setNotice({ report, message: 'Clipboard unavailable. Select the preview to copy it manually.' });
    }
  };
  const download = () => {
    if (!report || loading || failure) return;
    let url: string | undefined;
    try {
      url = URL.createObjectURL(new Blob([report.json], { type: 'application/json;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'cliharbor-diagnostics.json';
      document.body.append(link);
      try { link.click(); } finally { link.remove(); }
      setNotice({ report, message: 'Diagnostics download started. Review the local file before sharing.' });
    } catch {
      setNotice({ report, message: 'Your browser could not start the download. The preview remains available to copy and save.' });
    } finally {
      if (url) {
        const cleanupURL = url;
        window.setTimeout(() => { try { URL.revokeObjectURL(cleanupURL); } catch { /* Best-effort browser cleanup. */ } }, 1000);
      }
    }
  };
  return <section className="panel support-diagnostics" aria-labelledby="support-diagnostics-heading" aria-busy={loading}>
    <h2 id="support-diagnostics-heading">Support diagnostics</h2>
    <p>Prepare a metadata report to review, copy or download for support. Nothing is uploaded.</p>
    <p className="overview-hint">Includes build and platform versions, pack IDs and versions, tool readiness and counts. Excludes credentials, vendor endpoints, command inputs and output, executable paths and environment values.</p>
    <p className="overview-hint">The report is a snapshot. Refresh it after changing your setup.</p>
    <div className="result-export-actions">
      <button type="button" className="secondary-button" disabled={loading} aria-busy={loading} onClick={() => void prepare()}>
        {loading ? 'Preparing diagnostics…' : report ? 'Refresh diagnostics' : 'Prepare diagnostics'}
      </button>
      {report && <>
        <button type="button" className="secondary-button" disabled={loading || failure !== null} onClick={() => void copy()}>Copy diagnostics</button>
        <button type="button" className="secondary-button" disabled={loading || failure !== null} onClick={download}>Download diagnostics</button>
      </>}
    </div>
    <p role="status">{loading ? 'Reading current runtime metadata…' : notice?.report === report ? notice.message : ''}</p>
    {failure && <div role="alert"><p>{failure.message}</p><p>{failure.remediation}</p><p>Prepare diagnostics again before exporting.</p></div>}
    {report && <>
      {(loading || failure) && <p>Showing the previously prepared report. It has not been refreshed.</p>}
      <details className="technical-details"><summary>Review diagnostic JSON</summary><pre tabIndex={0} aria-label="Diagnostic JSON">{report.json}</pre></details>
      <p className="overview-hint">SHA-256 of this report: <code className="diagnostic-digest">{report.sha256}</code></p>
    </>}
  </section>;
}

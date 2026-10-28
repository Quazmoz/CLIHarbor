import { useState } from 'react';

interface ResultExportProps {
  fields: { field: string; value: string | null }[];
  runId?: string;
  disabled?: boolean;
}

function csvCell(value: string): string {
  // Output is untrusted: quoting alone does not stop spreadsheet formulas.
  // eslint-disable-next-line no-control-regex
  const text = /^[\s\u0000-\u001f]*[=+\-@]|^[\t\r\n]/u.test(value) ? "'" + value : value;
  return '"' + text.replaceAll('"', '""') + '"';
}

/** Explicit local downloads of displayed non-secret fields, never raw run/request objects. */
export function ResultExport({ fields, runId, disabled = false }: ResultExportProps) {
  const [notice, setNotice] = useState('');
  const download = (format: 'json' | 'csv') => {
    if (disabled || fields.length === 0) return;
    let objectURL: string | undefined;
    try {
      const content = format === 'json'
        ? JSON.stringify({ schemaVersion: 'cliharbor.result-fields/v1', runId, fields }, null, 2) + '\n'
        : '\uFEFF' + [
          ['Run ID', 'Field', 'Present', 'Value'],
          ...fields.map(({ field, value }) => [runId ?? '', field, String(value !== null), value ?? '']),
        ].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
      objectURL = URL.createObjectURL(new Blob([content], {
        type: format === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8',
      }));
      const link = document.createElement('a');
      link.href = objectURL;
      const suffix = runId && /^[a-f0-9]{32}$/.test(runId) ? '-' + runId : '';
      link.download = 'cliharbor-result' + suffix + '.' + format;
      document.body.append(link);
      try { link.click(); } finally { link.remove(); }
      setNotice(format.toUpperCase() + ' download started for ' + fields.length + ' displayed fields.');
    } catch {
      setNotice('Your browser could not start the download. The result remains available to inspect or copy.');
    } finally {
      if (objectURL !== undefined) {
        // Let the browser consume the object URL before releasing it.
        const cleanupURL = objectURL;
        window.setTimeout(() => {
          try { URL.revokeObjectURL(cleanupURL); } catch { /* Best-effort browser cleanup. */ }
        }, 1000);
      }
    }
  };

  return (
    <div className="result-export">
      <div className="result-export-actions" role="group" aria-label="Export displayed fields">
        <button type="button" className="secondary-button" disabled={disabled || fields.length === 0} onClick={() => download('json')}>Export JSON</button>
        <button type="button" className="secondary-button" disabled={disabled || fields.length === 0} onClick={() => download('csv')}>Export CSV</button>
        <span>Displayed fields only · local download</span>
      </div>
      <p className="structured-copy-status" role="status">{notice}</p>
    </div>
  );
}

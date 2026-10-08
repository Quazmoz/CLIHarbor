import { useMemo, useState, type ReactNode } from 'react';
import type { StructuredResult } from './api/runs';
import { StructuredResultView } from './StructuredResultView';

type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };
interface OutputRow { path: string; value: string; }
interface ParsedOutput { rows: OutputRow[]; truncated: boolean; }

const maxFormatBytes = 128 * 1024;
const maxRows = 200;
const maxDepth = 8;

function rowsFromJSON(stdout: string): ParsedOutput | null {
  if (!stdout.trim() || stdout.length > maxFormatBytes) return null;
  let value: JSONValue;
  try { value = JSON.parse(stdout) as JSONValue; } catch { return null; }
  if (value === null || typeof value !== 'object') return null;
  const rows: OutputRow[] = [];
  let truncated = false;
  const walk = (node: JSONValue, path: string, depth: number) => {
    if (rows.length >= maxRows) { truncated = true; return; }
    if (depth >= maxDepth) { truncated = true; return; }
    if (node === null || typeof node !== 'object') {
      const text = node === null ? 'null' : String(node);
      if (text.length > 8192) { truncated = true; return; }
      rows.push({ path: path || 'Value', value: text });
      return;
    }
    const entries = Array.isArray(node)
      ? node.map((entry, index) => [String(index), entry] as const)
      : Object.entries(node);
    for (const [key, entry] of entries) {
      if (rows.length >= maxRows) { truncated = true; break; }
      const nextPath = Array.isArray(node) ? path + '[' + key + ']' : path ? path + '.' + key : key;
      walk(entry, nextPath, depth + 1);
    }
  };
  walk(value, '', 0);
  return { rows, truncated };
}

interface OutputExplorerProps {
  stdout: string;
  stderr: string;
  structured?: StructuredResult;
  live?: boolean;
  rawOutput: ReactNode;
}

/** A presentation-only view of already-authorized process output, never a parser used for execution. */
export function OutputExplorer({ stdout, stderr, structured, live = false, rawOutput }: OutputExplorerProps) {
  const parsed = useMemo(() => live ? null : rowsFromJSON(stdout), [live, stdout]);
  const validated = structured?.status === 'available' && structured.fields !== undefined;
  const hasFormatted = validated || parsed !== null;
  const [mode, setMode] = useState<'formatted' | 'raw'>('formatted');
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState('');
  const rows = parsed?.rows.filter((row) => (row.path + ' ' + row.value).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) ?? [];
  const shownMode = hasFormatted && mode === 'formatted' ? 'formatted' : 'raw';

  const copy = async (row: OutputRow) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(row.value);
      setNotice('Copied ' + row.path + '.');
    } catch {
      setNotice('Clipboard unavailable. Select the value to copy manually.');
    }
  };

  return (
    <section className="output-explorer" aria-label="Command output">
      <div className="output-explorer-header">
        <div>
          <h3>Command output</h3>
          <p>{hasFormatted ? 'Inspect values or switch to the exact stdout and stderr.' : 'Original command output. Formatted view is available when structured JSON is returned.'}</p>
        </div>
        <div className="output-view-switch" role="group" aria-label="Output view">
          <button type="button" aria-pressed={shownMode === 'formatted'} disabled={!hasFormatted} onClick={() => setMode('formatted')}>Formatted</button>
          <button type="button" aria-pressed={shownMode === 'raw'} onClick={() => setMode('raw')}>Raw</button>
        </div>
      </div>
      {shownMode === 'formatted' ? (
        <>
          {validated ? <StructuredResultView fields={structured.fields ?? []} /> : (
            <div className="output-explorer-values">
              <div className="output-explorer-filter">
                <label htmlFor="output-value-search">Find an ID or value</label>
                <input id="output-value-search" type="search" placeholder="Search fields and values"
                  value={query} onChange={(event) => setQuery(event.target.value)} />
                <span>{rows.length} of {parsed?.rows.length ?? 0} values</span>
              </div>
              {parsed?.truncated && <p role="status" className="output-limit-note">Large or deeply nested result: preview is limited. Use Raw for the complete retained output.</p>}
              {rows.length === 0 ? <p role="status">No values match. Try a different search or switch to Raw.</p> : (
                <ul className="output-value-list">
                  {rows.map((row, index) => (
                    <li key={row.path + '-' + index}>
                      <span className="output-value-path">{row.path}</span>
                      <code className="output-value-text">{row.value}</code>
                      <button type="button" className="secondary-button" aria-label={'Copy ' + row.path + ' value'} onClick={() => void copy(row)}>Copy</button>
                    </li>
                  ))}
                </ul>
              )}
              {notice && <p role="status" aria-live="polite">{notice}</p>}
            </div>
          )}
          {stderr !== '' && <p className="output-stderr-notice">Stderr is available in the Raw view.</p>}
        </>
      ) : rawOutput}
    </section>
  );
}

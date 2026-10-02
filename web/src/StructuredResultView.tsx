import { useEffect, useMemo, useState } from 'react';
import type { StructuredField } from './api/runs';

type SortMode = 'source' | 'label' | 'key';

interface StructuredResultViewProps {
  fields: StructuredField[];
}

function searchableFieldText(field: StructuredField): string {
  return [field.label, field.key, field.present ? field.value : 'not provided']
    .join(' ')
    .toLocaleLowerCase();
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

function normalizedFieldJSON(fields: StructuredField[]): string {
  return JSON.stringify(
    fields.map((field) => ({
      key: field.key,
      label: field.label,
      type: field.type,
      present: field.present,
      value: field.present ? field.value : null,
    })),
    null,
    2,
  );
}

export function StructuredResultView({ fields }: StructuredResultViewProps) {
  const [query, setQuery] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('source');
  const [copyNotice, setCopyNotice] = useState<string | null>(null);

  useEffect(() => {
    setCopyNotice(null);
  }, [fields]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleFields = useMemo(() => {
    const indexed = fields
      .map((field, index) => ({ field, index }))
      .filter(({ field }) => normalizedQuery.length === 0 || searchableFieldText(field).includes(normalizedQuery));

    if (sortMode === 'source') {
      return indexed.map(({ field }) => field);
    }

    return indexed
      .sort((left, right) => {
        const leftValue = sortMode === 'label' ? left.field.label : left.field.key;
        const rightValue = sortMode === 'label' ? right.field.label : right.field.key;
        return compareText(leftValue, rightValue) || left.index - right.index;
      })
      .map(({ field }) => field);
  }, [fields, normalizedQuery, sortMode]);

  const jsonView = useMemo(() => normalizedFieldJSON(fields), [fields]);

  const copyFieldValue = async (field: StructuredField) => {
    if (!field.present) {
      return;
    }
    try {
      if (navigator.clipboard?.writeText === undefined) {
        throw new Error('clipboard unavailable');
      }
      await navigator.clipboard.writeText(field.value);
      setCopyNotice(`Copied ${field.label}.`);
    } catch {
      setCopyNotice(`Could not copy ${field.label}. Clipboard access is unavailable in this browser.`);
    }
  };

  return (
    <>
      <div className="structured-result-controls">
        <label className="structured-result-control">
          <span>Filter fields</span>
          <input
            type="search"
            value={query}
            placeholder="Label, key, or value"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label className="structured-result-control">
          <span>Sort fields</span>
          <select value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)}>
            <option value="source">Source order</option>
            <option value="label">Label A–Z</option>
            <option value="key">Key A–Z</option>
          </select>
        </label>
        <span className="structured-result-count">
          {visibleFields.length} of {fields.length}
        </span>
      </div>

      {visibleFields.length === 0 ? (
        <p className="structured-result-empty" role="status">
          No structured fields match this filter.
        </p>
      ) : (
        <dl className="structured-grid">
          {visibleFields.map((field) => (
            <div key={field.key} className="structured-card">
              <dt>
                <span>{field.label}</span>
                <button
                  type="button"
                  className="structured-copy-button"
                  disabled={!field.present}
                  aria-label={`Copy ${field.label} value`}
                  onClick={() => void copyFieldValue(field)}
                >
                  Copy value
                </button>
              </dt>
              <dd>{field.present ? field.value : 'Not provided'}</dd>
            </div>
          ))}
        </dl>
      )}

      {copyNotice !== null && (
        <p className="structured-copy-status" role="status" aria-live="polite">
          {copyNotice}
        </p>
      )}

      <details className="structured-json">
        <summary>Normalized JSON view</summary>
        <p>Built only from CLIHarbor's validated structured fields; raw stdout and stderr are not added here.</p>
        <pre tabIndex={0}>{jsonView}</pre>
      </details>
    </>
  );
}

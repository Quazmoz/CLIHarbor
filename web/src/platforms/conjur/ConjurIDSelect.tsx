import { useEffect, useId, useRef, useState } from 'react';

/** Visible inventory is a convenience, not an existence/authorization verdict. */
export function ConjurIDSelect({ label, value, options, onChange, disabled = false, required = true, maxLength = 2048, error, id, loading = false }: {
  label: string; value: string; options: readonly string[]; onChange: (value: string) => void;
  disabled?: boolean; required?: boolean; maxLength?: number;
  error?: string; id?: string;
  loading?: boolean;
}) {
  const generated = useId();
  const controlID = id ?? generated;
  const [manual, setManual] = useState(false);
  const manualInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (manual) manualInput.current?.focus(); }, [manual]);
  const other = manual || Boolean(value && !options.includes(value));
  return <div className="field-group">
    <label className="field"><span>{label}</span>
      <select id={controlID} value={other ? 'manual' : value ? 'value:' + value : ''} disabled={disabled} required={required && !other}
        aria-busy={loading}
        aria-invalid={error && !other ? true : undefined} aria-describedby={error ? controlID + '-error' : undefined}
        onChange={(event) => {
          setManual(event.target.value === 'manual');
          onChange(event.target.value.startsWith('value:') ? event.target.value.slice(6) : '');
        }}>
        <option value="">{required ? 'Choose an option' : 'Not set'}</option>
        {[...new Set(options)].map((option) => <option key={option} value={'value:' + option}>{option}</option>)}
        <option value="manual">Enter another ID…</option>
      </select>
    </label>
    {other && <label className="field"><span>{label} — enter ID</span>
      <input ref={manualInput} id={controlID + '-manual'} value={value} required={required} maxLength={maxLength} disabled={disabled} spellCheck={false}
        aria-invalid={error ? true : undefined} aria-describedby={error ? controlID + '-error' : undefined}
        onChange={(event) => onChange(event.target.value)} />
    </label>}
    {error && <p id={controlID + '-error'} className="field-error" role="alert">{error}</p>}
  </div>;
}

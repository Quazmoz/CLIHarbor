import { useEffect, useRef, useState, type ClipboardEvent, type ReactNode } from 'react';
import type { Task, TaskInput } from './api/tasks';
import { invalidInputError, type AppErrorDetail } from './api/errors';
import { inputGuidance } from './operatorLanguage';

export type FormValue = string | boolean | string[];

export function initialValues(task: Task | undefined): Record<string, FormValue> {
  const values: Record<string, FormValue> = {};
  for (const input of task?.inputs ?? []) {
    switch (input.type) {
      case 'boolean':
        values[input.id] = false;
        break;
      case 'multiselect':
        values[input.id] = [];
        break;
      case 'enum':
        values[input.id] = input.required ? (input.validation?.enum?.[0] ?? '') : '';
        break;
      default:
        values[input.id] = '';
    }
  }
  return values;
}

export function requestValues(task: Task, formValues: Record<string, FormValue>): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const input of task.inputs) {
    const value = formValues[input.id];
    if (input.type === 'boolean') {
      values[input.id] = value === true;
      continue;
    }
    if (input.type === 'multiselect') {
      const selected = Array.isArray(value) ? value : [];
      if (input.required || selected.length > 0) {
        values[input.id] = selected;
      }
      continue;
    }
    const text = typeof value === 'string' ? value : '';
    if (input.required && (text.length === 0 || (input.type === 'integer' && text.trim().length === 0))) {
      throw invalidInputError(`values.${input.id}`);
    }
    if (!input.required && text.length === 0) {
      continue;
    }
    if (input.type === 'integer') {
      const integer = Number(text);
      if (!Number.isSafeInteger(integer)) {
        throw invalidInputError(`values.${input.id}`);
      }
      values[input.id] = integer;
    } else {
      values[input.id] = text;
    }
  }
  return values;
}

export function taskInputDOMID(inputID: string, prefix = 'task-input'): string {
  return `${prefix}-${inputID}`;
}

function FieldFailure({ id, failure }: { id: string; failure: AppErrorDetail }) {
  return (
    <p id={id} className="field-error" role="alert">
      {failure.message} {failure.remediation}
    </p>
  );
}

function FieldLabel({ input }: { input: TaskInput }) {
  return (
    <span className="field-label-text">
      <span>{input.label}</span>
      <span className="field-requirement" aria-hidden="true">
        {input.required ? 'Required' : 'Optional'}
      </span>
    </span>
  );
}

const PEM_HEADER = /-----BEGIN [A-Z0-9 ]+-----/u;

export function SecretValueControl({
  id, label, value, onChange, required, disabled, minLength, maxLength, invalid = false, describedBy,
}: {
  id: string;
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  disabled?: boolean;
  minLength?: number;
  maxLength?: number;
  invalid?: boolean;
  describedBy?: string;
}) {
  const [multiline, setMultiline] = useState(false);
  const [pasteBlocked, setPasteBlocked] = useState(false);
  const maskedInput = useRef<HTMLInputElement>(null);
  const multilineInput = useRef<HTMLTextAreaElement>(null);
  const tooLong = maxLength !== undefined && value.length > maxLength;
  const lengthError = tooLong ? `Secret value exceeds the ${maxLength}-character limit. Nothing was truncated; shorten it before reviewing.` : '';

  useEffect(() => {
    const element = multiline ? multilineInput.current : maskedInput.current;
    element?.setCustomValidity(lengthError);
  }, [multiline, lengthError]);

  const change = (next: string) => {
    if (!multiline && PEM_HEADER.test(next)) {
      setPasteBlocked(true);
      onChange('');
      return;
    }
    setPasteBlocked(false);
    onChange(next);
  };
  const paste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData('text/plain');
    if (/[\r\n]/u.test(text) || PEM_HEADER.test(text)) {
      event.preventDefault();
      setPasteBlocked(true);
      onChange('');
    }
  };
  const control = {
    id, required, disabled, minLength, value, autoComplete: 'off', spellCheck: false,
    'aria-invalid': invalid || tooLong,
    'aria-describedby': [describedBy, tooLong ? id + '-length-error' : undefined].filter(Boolean).join(' ') || undefined,
  };

  return <>
    <label className="checkbox-row secret-multiline-toggle">
      <input type="checkbox" checked={multiline} disabled={disabled} aria-describedby={id + '-multiline-help'}
        onChange={(event) => {
          setMultiline(event.target.checked);
          setPasteBlocked(false);
          onChange('');
        }} />
      Multi-line value, such as a certificate, private key or JSON
    </label>
    <p id={id + '-multiline-help'} className="field-help">The multi-line field is shown on screen. Make sure nobody else can see it. Switching modes clears the value.</p>
    <label className="field">
      {label}
      {multiline
        ? <textarea {...control} ref={multilineInput} rows={8} onChange={(event) => change(event.target.value)} />
        : <input {...control} ref={maskedInput} type="password" onPaste={paste} onChange={(event) => change(event.target.value)} />}
    </label>
    {pasteBlocked && <p role="alert">The masked field cannot preserve a multi-line value or certificate. The field was cleared; select Multi-line value and paste the original again.</p>}
    {tooLong && <p id={id + '-length-error'} className="field-error" role="alert">{lengthError}</p>}
  </>;
}

export function InputControl({
  input,
  value,
  onChange,
  error,
  idPrefix = 'task-input',
}: {
  input: TaskInput;
  value: FormValue | undefined;
  onChange: (value: FormValue) => void;
  error?: AppErrorDetail;
  idPrefix?: string;
}) {
  const validation = input.validation ?? {};
  const domID = taskInputDOMID(input.id, idPrefix);
  const errorID = `${domID}-error`;
  const helpID = `${domID}-help`;
  const guidance = inputGuidance(input);
  const describedBy = [guidance === undefined ? undefined : helpID, error === undefined ? undefined : errorID]
    .filter((id): id is string => id !== undefined)
    .join(' ') || undefined;

  if (input.type === 'boolean') {
    return (
      <div className="field-group">
        <label className="checkbox-row">
          <input
            id={domID}
            type="checkbox"
            checked={value === true}
            aria-invalid={error === undefined ? undefined : true}
            aria-describedby={describedBy}
            onChange={(event) => onChange(event.target.checked)}
          />
          <FieldLabel input={input} />
        </label>
        {guidance && <p id={helpID} className="field-help">{guidance}</p>}
        {error && <FieldFailure id={errorID} failure={error} />}
      </div>
    );
  }

  if (input.type === 'enum') {
    return (
      <div className="field-group">
        <label className="field">
          <FieldLabel input={input} />
          <select
            id={domID}
            required={input.required}
            value={typeof value === 'string' ? value : ''}
            aria-invalid={error === undefined ? undefined : true}
            aria-describedby={describedBy}
            onChange={(event) => onChange(event.target.value)}
          >
            {!input.required && <option value="">Not set</option>}
            {(validation.enum ?? []).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        {guidance && <p id={helpID} className="field-help">{guidance}</p>}
        {error && <FieldFailure id={errorID} failure={error} />}
      </div>
    );
  }

  if (input.type === 'multiselect') {
    const selected = Array.isArray(value) ? value : [];
    return (
      <div className="field-group">
        <label className="field">
          <FieldLabel input={input} />
          <select
            id={domID}
            multiple
            required={input.required}
            value={selected}
            aria-invalid={error === undefined ? undefined : true}
            aria-describedby={describedBy}
            onChange={(event) => onChange(Array.from(event.target.selectedOptions, (option) => option.value))}
          >
            {(validation.enum ?? []).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        {guidance && <p id={helpID} className="field-help">{guidance}</p>}
        {error && <FieldFailure id={errorID} failure={error} />}
      </div>
    );
  }

  if (input.type === 'secret') {
    return (
      <div className="field-group">
        <SecretValueControl id={domID} label={<FieldLabel input={input} />}
          value={typeof value === 'string' ? value : ''} onChange={onChange}
          required={input.required} minLength={validation.minLength} maxLength={validation.maxLength}
          invalid={error !== undefined} describedBy={describedBy} />
        {guidance && <p id={helpID} className="field-help">{guidance}</p>}
        {error && <FieldFailure id={errorID} failure={error} />}
      </div>
    );
  }

  return (
    <div className="field-group">
      <label className="field">
        <FieldLabel input={input} />
        <input
          id={domID}
          type={input.type === 'integer' ? 'number' : 'text'}
          required={input.required}
          value={typeof value === 'string' ? value : ''}
          step={input.type === 'integer' ? 1 : undefined}
          min={input.type === 'integer' ? validation.min : undefined}
          max={input.type === 'integer' ? validation.max : undefined}
          minLength={input.type === 'string' ? validation.minLength : undefined}
          maxLength={input.type === 'string' ? validation.maxLength : undefined}
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      {guidance && <p id={helpID} className="field-help">{guidance}</p>}
      {error && <FieldFailure id={errorID} failure={error} />}
    </div>
  );
}

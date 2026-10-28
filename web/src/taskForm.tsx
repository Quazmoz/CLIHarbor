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

  return (
    <div className="field-group">
      <label className="field">
        <FieldLabel input={input} />
        <input
          id={domID}
          type={input.type === 'integer' ? 'number' : input.type === 'secret' ? 'password' : 'text'}
          autoComplete={input.type === 'secret' ? 'off' : undefined}
          spellCheck={input.type === 'secret' ? false : undefined}
          required={input.required}
          value={typeof value === 'string' ? value : ''}
          step={input.type === 'integer' ? 1 : undefined}
          min={input.type === 'integer' ? validation.min : undefined}
          max={input.type === 'integer' ? validation.max : undefined}
          minLength={input.type === 'string' || input.type === 'secret' ? validation.minLength : undefined}
          maxLength={input.type === 'string' || input.type === 'secret' ? validation.maxLength : undefined}
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

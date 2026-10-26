import type { ReactNode } from 'react';
import type { RunExecutionContextField } from './api/runs';

export function ExecutionContext({ fields, target }: { fields: RunExecutionContextField[]; target?: string }) {
  return <dl className="operation-context" aria-label="Execution context">
    {fields.map((field) => <div key={field.label}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}
    {target && <div><dt>Target</dt><dd>{target}</dd></div>}
  </dl>;
}

export interface OperationOutcome {
  title: string;
  tone: 'success' | 'warning';
  target?: string;
  steps: Array<{ label: string; state: 'done' | 'unknown' | 'not-started' }>;
  next: string;
}

export function OperationResult({ result, children }: { result: OperationOutcome; children?: ReactNode }) {
  return <section className={'operation-result operation-result--' + result.tone} aria-label="Operation result" role="status" aria-live="polite">
    <h4>{result.tone === 'success' ? '✓ ' : '! '}{result.title}</h4>
    {result.target && <p><strong>Target:</strong> <code>{result.target}</code></p>}
    <ul>{result.steps.map((step) => <li key={step.label}><span aria-hidden="true">{step.state === 'done' ? '✓' : step.state === 'unknown' ? '?' : '–'} </span>
      {step.label}: <strong>{step.state === 'done' ? 'Confirmed' : step.state === 'unknown' ? 'Unconfirmed' : 'Not started'}</strong></li>)}</ul>
    <p>{result.next}</p>
    {children && <div className="tool-install-actions">{children}</div>}
  </section>;
}

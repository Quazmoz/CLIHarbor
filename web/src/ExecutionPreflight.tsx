import type { Task } from './api/tasks';
import type { ToolDiagnostic } from './api/tools';

type CheckTone = 'pass' | 'pending' | 'info' | 'warn' | 'fail';

interface PreflightCheck {
  title: string;
  detail: string;
  status: string;
  tone: CheckTone;
}

interface ExecutionPreflightProps {
  task: Task | undefined;
  tool: ToolDiagnostic | undefined;
  validated: boolean;
  validating: boolean;
  validationFailed: boolean;
  approvalReady: boolean;
}

const riskLabel = { read: 'Read-only', change: 'Change · approval required', destructive: 'Destructive · approval required' } as const;

function CheckIcon({ tone }: { tone: CheckTone }) {
  const paths: Record<CheckTone, string> = {
    pass: 'm7.5 12.5 3 3 6-7',
    pending: 'M12 7v5l3 2',
    info: 'M12 11v6 M12 7.5v.01',
    warn: 'M12 8v5 M12 16.5v.01',
    fail: 'm9 9 6 6 M15 9l-6 6',
  };
  return (
    <span className={'preflight-icon preflight-icon--' + tone} aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d={paths[tone]} /></svg>
    </span>
  );
}

/** Presentation-only summary of state the runtime already reported; it grants no execution authority. */
export function ExecutionPreflight({ task, tool, validated, validating, validationFailed, approvalReady }: ExecutionPreflightProps) {
  if (task === undefined) {
    return (
      <aside className="panel execution-preflight" aria-labelledby="preflight-heading">
        <h2 id="preflight-heading">Execution Preflight</h2>
        <p>Select a task to see its readiness checks.</p>
      </aside>
    );
  }
  const toolReady = tool?.status === 'ready';
  const mutation = task.risk !== 'read';
  const checks: PreflightCheck[] = [
    toolReady
      ? { title: 'Executable found', detail: `${task.toolId}${tool.version ? ' ' + tool.version : ''} resolved by the local runtime`, status: 'Passed', tone: 'pass' }
      : { title: 'Executable found', detail: tool?.message ?? `${task.toolId} is not currently available`, status: tool?.status === 'missing' ? 'Missing' : 'Unavailable', tone: 'fail' },
    { title: 'Trusted configuration', detail: `Reviewed pack: ${task.packName}${tool?.packVersion ? ' ' + tool.packVersion : ''}`, status: 'Passed', tone: 'pass' },
    validating
      ? { title: 'Input validation', detail: 'Checking inputs with the local runtime…', status: 'Checking', tone: 'pending' }
      : validated
        ? { title: 'Input validation', detail: 'Inputs and command boundary validated', status: 'Passed', tone: 'pass' }
        : validationFailed
          ? { title: 'Input validation', detail: 'Fix the reported input, then validate again', status: 'Failed', tone: 'fail' }
          : { title: 'Input validation', detail: mutation ? 'Review is required before this change can run' : 'Validate to confirm the exact command', status: 'Pending', tone: 'pending' },
    task.requiresAuth
      ? { title: 'Vendor session', detail: `${task.toolId} must be signed in; this page does not verify it`, status: 'Sign-in required', tone: 'info' }
      : { title: 'Vendor session', detail: 'This task needs no vendor sign-in', status: 'Not required', tone: 'pass' },
    !toolReady
      ? { title: 'Execution readiness', detail: 'Blocked until the executable is available', status: 'Blocked', tone: 'fail' }
      : mutation
        ? approvalReady
          ? { title: 'Execution readiness', detail: 'Reviewed change is approved for this exact plan', status: 'Approved', tone: 'pass' }
          : { title: 'Execution readiness', detail: 'Changes vendor state; explicit approval required', status: 'Requires approval', tone: 'warn' }
        : { title: 'Execution readiness', detail: 'Read-only task is ready to run', status: 'Ready', tone: 'pass' },
  ];

  return (
    <aside className="panel execution-preflight" aria-labelledby="preflight-heading">
      <h2 id="preflight-heading">
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"><path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6z" /><path d="m8.5 12 2.5 2.5 4.5-5" strokeLinecap="round" /></svg>
        Execution Preflight
      </h2>
      <ul className="preflight-checks">
        {checks.map((check) => (
          <li key={check.title}>
            <CheckIcon tone={check.tone} />
            <span className="preflight-copy">
              <strong>{check.title}</strong>
              <span>{check.detail}</span>
            </span>
            <span className={'preflight-status preflight-status--' + check.tone}>{check.status}</span>
          </li>
        ))}
      </ul>
      <details className="execution-summary">
        <summary>Technical details</summary>
        <dl>
          <div><dt>Executable</dt><dd>{task.toolId}{tool?.version ? ' ' + tool.version : ''}</dd></div>
          <div><dt>Pack</dt><dd>{task.packName}</dd></div>
          <div><dt>Command</dt><dd>{task.commandId}</dd></div>
          <div><dt>Risk</dt><dd>{riskLabel[task.risk]}</dd></div>
          <div><dt>Execution mode</dt><dd>Direct (no shell, no elevation)</dd></div>
        </dl>
      </details>
    </aside>
  );
}

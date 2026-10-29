import type { MouseEvent } from 'react';
import type { ToolDiagnostic } from './api/tools';
import { authenticationCheckFor, type AuthenticationChecks } from './AuthenticationPage';
import { ToolIcon } from './ToolIcon';
import type { Task } from './api/tasks';
import { useOperationActivity } from './OperationActivity';

export function CliSessionStatus({ tools, checks, onOpenSignIn, tasks = [], onCheckSession }: {
  tools: ToolDiagnostic[];
  checks: AuthenticationChecks;
  onOpenSignIn: (event: MouseEvent<HTMLAnchorElement>) => void;
  tasks?: Task[];
  onCheckSession?: (tool: ToolDiagnostic) => void;
}) {
  const { local } = useOperationActivity();
  const sessions = tools.filter((tool) => tool.requiresVendorSession === true).map((tool) => {
    const check = authenticationCheckFor(tool, checks);
    const busy = Object.values(local).some((item) => item.anchor === 'vendor-session-' + tool.packId + '__' + tool.toolId);
    let label = 'Not checked';
    let symbol = '?';
    if (tool.status !== 'ready') { label = 'CLI unavailable'; symbol = '!'; }
    else if (tool.sessionCheck === undefined) { label = 'Check unavailable'; symbol = '–'; }
    else if (busy) { label = 'Updating sign-in…'; symbol = '…'; }
    else if (check?.kind === 'authenticated') { label = 'Signed in'; symbol = '✓'; }
    else if (check?.kind === 'required') { label = 'Sign-in required'; symbol = '!'; }
    else if (check?.kind === 'checking') { label = 'Checking…'; symbol = '…'; }
    else if (check?.kind === 'failed') { label = 'Check failed'; symbol = '!'; }
    else if (check?.kind === 'cancelled') { label = 'Check cancelled'; symbol = '–'; }
    return { tool, check, busy, label, symbol, signedIn: label === 'Signed in' };
  });
  const signedIn = sessions.filter((session) => session.signedIn);
  const sessionLabel = signedIn.length > 0 ? signedIn.length + ' signed in' : 'CLI sessions';

  return (
    <details className="cli-sessions" onKeyDown={(event) => {
      if (event.key === 'Escape' && event.currentTarget.open) {
        event.stopPropagation();
        event.currentTarget.open = false;
        event.currentTarget.querySelector('summary')?.focus();
      }
    }} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
    }}>
      <summary aria-label={'CLI sign-in status, ' + signedIn.length + ' verified, ' + sessionLabel}
        title={signedIn.length > 0 ? 'Verified: ' + signedIn.map(({ tool }) => tool.toolId).join(', ') : 'View CLI sign-in status'}>
        <span className={'cli-session-dot' + (signedIn.length > 0 ? ' cli-session-dot--signed-in' : '')} aria-hidden="true" />
        <span aria-live="polite" aria-atomic="true">{sessionLabel}</span>
        <span aria-hidden="true">⌄</span>
      </summary>
      <div className="cli-sessions-panel">
        <h2>CLI sign-in status</h2>
        <p>Last verified sessions. Re-check after changing accounts or signing out in a CLI.</p>
        {sessions.length === 0 ? <p>No CLIs require sign-in.</p> : (
          <ul>
            {sessions.map(({ tool, check, busy, label, symbol, signedIn }) => (
              <li key={tool.packId + '/' + tool.toolId}>
                <ToolIcon tool={tool} />
                <div className="cli-session-tool">
                  <strong>{tool.toolId}</strong>
                  <span>{tool.packName || tool.packId}</span>
                  {check !== undefined && 'checkedAt' in check && (
                    <small>Checked <time dateTime={check.checkedAt}>{new Date(check.checkedAt).toLocaleString()}</time></small>
                  )}
                </div>
                <span className={'cli-session-label' + (signedIn ? ' cli-session-label--signed-in' : '')}>
                  <span aria-hidden="true">{symbol} </span>{label}
                </span>
                {onCheckSession && <button type="button" className="secondary-button cli-session-check"
                  aria-label={'Check session for ' + (tool.packName || tool.packId) + ' / ' + tool.toolId}
                  aria-busy={busy || check?.kind === 'checking'} disabled={busy || check?.kind === 'checking' || tool.status !== 'ready' ||
                    !tasks.some((task) => task.packId === tool.packId && task.toolId === tool.toolId &&
                      task.commandId === tool.sessionCheck?.commandId && task.risk === 'read' && task.requiresAuth && task.inputs.length === 0)}
                  onClick={() => onCheckSession(tool)}>{check?.kind === 'checking' ? 'Checking…' : 'Check session'}</button>}
              </li>
            ))}
          </ul>
        )}
        <a href="/authentication" onClick={(event) => {
          onOpenSignIn(event);
          if (event.defaultPrevented) event.currentTarget.closest('details')?.removeAttribute('open');
        }}>Manage sign-ins &amp; check sessions →</a>
      </div>
    </details>
  );
}

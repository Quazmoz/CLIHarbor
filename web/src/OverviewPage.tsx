import { useMemo } from 'react';
import { VendorSessionCard, type DedicatedSignInLink } from './AuthenticationPage';
import type { RuntimeStatus } from './api/status';
import type { Task } from './api/tasks';
import type { ToolDiagnostic } from './api/tools';
import { taskIdentityKey, type TaskPreferences } from './taskPreferences';

export type OverviewDestination = 'authentication' | 'tasks' | 'runs' | 'tools' | 'diagnostics';

interface OverviewPageProps {
  status: RuntimeStatus;
  tasks: Task[];
  tools: ToolDiagnostic[];
  preferences: TaskPreferences;
  onNavigate: (destination: OverviewDestination) => void;
  onOpenTask: (taskKey: string) => void;
  /** Navigates to the existing scoped task catalog; never starts a command. */
  onOpenTool: (toolKey: string) => void;
  /** An active run owns the task selection until it completes. */
  navigationLocked?: boolean;
  /** Tools owned by a dedicated platform sign in from that platform's section. */
  dedicatedSignInFor?: (tool: ToolDiagnostic) => DedicatedSignInLink | undefined;
}

function taskKey(task: Task): string {
  return task.packId + '/' + task.commandId;
}

function quickTasks(tasks: Task[], preferences: TaskPreferences): Task[] {
  const byIdentity = new Map(tasks.map((task) => [taskIdentityKey(task), task] as const));
  const ordered = [...preferences.favorites, ...preferences.recent];
  const seen = new Set<string>();
  const result: Task[] = [];

  for (const identity of ordered) {
    const identityKey = taskIdentityKey(identity);
    if (seen.has(identityKey)) {
      continue;
    }
    seen.add(identityKey);
    const task = byIdentity.get(identityKey);
    if (task !== undefined) {
      result.push(task);
    }
    if (result.length >= 4) {
      break;
    }
  }

  return result;
}

export function OverviewPage({
  status,
  tasks,
  tools,
  preferences,
  onNavigate,
  onOpenTask,
  onOpenTool,
  navigationLocked = false,
  dedicatedSignInFor,
}: OverviewPageProps) {
  const readyToolCount = tools.filter((tool) => tool.status === 'ready').length;
  const attentionToolCount = tools.length - readyToolCount;
  const vendorSessionTaskCount = tasks.filter((task) => task.requiresAuth === true).length;
  const vendorSessionTools = tools.filter(
    (tool) => tool.status === 'ready' && tool.requiresVendorSession === true,
  );
  const hasGuidedCredentialLogin = vendorSessionTools.some(
    (tool) => tool.credentialLogin !== undefined,
  );
  const shortcuts = useMemo(() => quickTasks(tasks, preferences), [tasks, preferences]);
  const taskCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of tasks) {
      const key = task.packId + '/' + task.toolId;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [tasks]);
  const workflowReady = readyToolCount > 0 && tasks.length > 0;

  let recommendedTitle = 'Choose a safe task';
  let recommendedCopy = 'The local runtime has safe tasks available. Open Tasks to select, validate, preview, and run one.';
  let recommendedDestination: OverviewDestination = 'tasks';
  let recommendedAction = 'Open tasks';

  if (tools.length === 0) {
    recommendedTitle = 'Configure a reviewed CLI pack';
    recommendedCopy = 'No tools are configured yet. Diagnostics explains the trusted-pack and tool-readiness state without exposing execution paths.';
    recommendedDestination = 'diagnostics';
    recommendedAction = 'Open diagnostics';
  } else if (attentionToolCount > 0 && tasks.length === 0) {
    recommendedTitle = 'Resolve tool readiness';
    recommendedCopy = attentionToolCount + ' configured tool' + (attentionToolCount === 1 ? ' needs' : 's need') + ' attention before every exposed workflow is available.';
    recommendedDestination = 'diagnostics';
    recommendedAction = 'Review tool readiness';
  } else if (tasks.length === 0) {
    recommendedTitle = 'Load an approved task catalog';
    recommendedCopy = 'The configured tools are ready, but the runtime is not exposing any browser-safe tasks.';
    recommendedDestination = 'diagnostics';
    recommendedAction = 'Review diagnostics';
  }

  return (
    <section className="overview-page" aria-labelledby="overview-heading">
      <div className="panel overview-hero">
        <div className="overview-hero-copy">
          <div className="overview-status-line" aria-label="Local workspace status">
            <span className={'overview-status-indicator' + (tools.length === 0 || attentionToolCount > 0 ? ' overview-status-indicator--attention' : '')} aria-hidden="true" />
            <span>Local operator workspace</span>
            <span className="overview-status-separator" aria-hidden="true">/</span>
            <span>{readyToolCount} of {tools.length} tools detected</span>
          </div>
          <h2 id="overview-heading">{workflowReady ? 'What would you like to do?' : 'Get your CLIs ready'}</h2>
          <p>
            {workflowReady
              ? 'Pick an approved task to get started, or set up another CLI. Each command runs locally on this computer.'
              : 'Review your approved tools and resolve setup needs before running commands locally.'}
          </p>
        </div>
        <div className="overview-hero-actions">
          <button type="button" onClick={() => onNavigate(recommendedDestination)}>
            {recommendedAction}
          </button>
          <button type="button" className="secondary-button" onClick={() => onNavigate('tools')}>Add a CLI</button>
        </div>
      </div>

      <div className="overview-metrics" aria-label="Workspace summary">
        <div className="overview-metric">
          <span>Tool readiness</span>
          <strong>{readyToolCount}/{tools.length} ready</strong>
          <p>{tools.length === 0 ? 'No tools are configured.' : attentionToolCount === 0 ? 'No configured tool needs attention.' : attentionToolCount + ' tool state' + (attentionToolCount === 1 ? '' : 's') + ' need review.'}</p>
        </div>
        <div className="overview-metric">
          <span>Available tasks</span>
          <strong>{tasks.length} task{tasks.length === 1 ? '' : 's'}</strong>
          <p>
            {vendorSessionTaskCount === 0
              ? 'None require sign-in.'
              : `${vendorSessionTaskCount} ${vendorSessionTaskCount === 1 ? 'task requires' : 'tasks require'} sign-in before use.`}
          </p>
        </div>
        <div className="overview-metric">
          <span>Execution boundary</span>
          <strong>Local only</strong>
          <p>Your tools run on this computer. Credentials remain in vendor-owned storage.</p>
        </div>
      </div>

      <div className="overview-layout">
        <article className="panel" aria-labelledby="next-step-heading">
          <p className="status-label">Why this is next</p>
          <h2 id="next-step-heading">{recommendedTitle}</h2>
          <p>{recommendedCopy}</p>
          <p className="overview-hint">Use the primary action above to continue, or choose a specific task from your shortcuts.</p>
        </article>

        <article className="panel" aria-labelledby="quick-tasks-heading">
          <p className="status-label">Quick entry</p>
          <h2 id="quick-tasks-heading">Favorites & recent tasks</h2>
          {navigationLocked && shortcuts.length > 0 && (
            <p className="overview-selection-notice" role="status">
              Finish or cancel the active run before selecting another task.
            </p>
          )}
          {shortcuts.length === 0 ? (
            <div className="overview-empty">
              <p>{tasks.length > 0
                ? 'Favorite a task or run one once and it will appear here for faster return access.'
                : 'No approved tasks are available yet. Review your CLI setup to enable workflows.'}</p>
              {tasks.length > 0 && (
                <div className="overview-panel-actions">
                  <button type="button" className="secondary-button" onClick={() => onNavigate('tasks')}>
                    Browse tasks
                  </button>
                </div>
              )}
            </div>
          ) : (
            <ul className="quick-task-list">
              {shortcuts.map((task) => (
                <li key={taskKey(task)}>
                  <button type="button" className="quick-task-button" disabled={navigationLocked} onClick={() => onOpenTask(taskKey(task))}>
                    <strong>{task.name}</strong>
                    <span>{task.packName} · {task.toolId}</span>
                    <span className="quick-task-flags">
                      <span className={'task-risk-badge task-risk-badge--' + task.risk}>
                        {task.risk === 'read' ? 'Read-only' : task.risk === 'change' ? 'Change · approval required' : 'Destructive · approval required'}
                      </span>
                      {task.requiresAuth && <span className="task-auth-badge">Sign-in required</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </article>
      </div>

      <section className="panel overview-tool-section" aria-labelledby="overview-tools-heading">
        <div className="overview-section-heading">
          <div>
            <p className="status-label">Environment at a glance</p>
            <h2 id="overview-tools-heading">Your command-line tools</h2>
            <p>Detection confirms the executable is available, not that you are signed in. Tasks below come from approved packs only.</p>
          </div>
          <button type="button" className="secondary-button" onClick={() => onNavigate('diagnostics')}>View diagnostics</button>
        </div>
        {tools.length === 0 ? (
          <div className="overview-empty">
            <p>No reviewed CLI tools are configured. Add a supported CLI to get started.</p>
          </div>
        ) : (
          <ul className="overview-tool-grid" aria-label="Configured command-line tools">
            {tools.map((tool) => {
              const key = tool.packId + '/' + tool.toolId;
              const count = taskCounts.get(key) ?? 0;
              const ready = tool.status === 'ready';
              return (
                <li key={key + '/' + tool.packVersion} className={'overview-tool' + (ready ? ' overview-tool--ready' : ' overview-tool--attention')}>
                  <div className="overview-tool-top">
                    <span className="overview-tool-symbol" aria-hidden="true">&gt;_</span>
                    <span className="overview-tool-state">{ready ? 'Detected' : tool.status.replaceAll('-', ' ')}</span>
                  </div>
                  <h3>{tool.packName}</h3>
                  <p className="overview-tool-identity">{tool.toolId}{tool.version ? ' · ' + tool.version : ''}</p>
                  <p className="overview-tool-description">
                    {ready
                      ? count > 0
                        ? count + ' approved ' + (count === 1 ? 'task' : 'tasks') + ' available.' +
                          (tool.requiresVendorSession ? ' Vendor sign-in is checked separately.' : '')
                        : 'Executable detected. No approved browser tasks are available.'
                      : tool.message || 'This tool needs attention before its workflows are available.'}
                  </p>
                  <div className="overview-tool-footer">
                    <button type="button" className="secondary-button"
                      disabled={navigationLocked && ready && count > 0}
                      aria-label={ready && count > 0 ? 'Browse ' + tool.packName + ' ' + tool.toolId + ' tasks' : 'Diagnose ' + tool.packName + ' ' + tool.toolId}
                      onClick={() => {
                        if (ready && count > 0) {
                          onOpenTool(key);
                        } else {
                          onNavigate('diagnostics');
                        }
                      }}>
                      {ready && count > 0 ? 'Browse tasks →' : 'Troubleshoot →'}
                    </button>
                    {ready && count > 0 && <span>{count} {count === 1 ? 'workflow' : 'workflows'}</span>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {vendorSessionTools.length > 0 && (
        <section className="overview-login" aria-labelledby="overview-login-heading">
          <div className="route-heading">
            <p className="status-label">Per-CLI sign-in</p>
            <h2 id="overview-login-heading">{hasGuidedCredentialLogin ? 'Connect your CLIs' : 'CLI session checks'}</h2>
            <p>
              Connect your tools using their supported sign-in method, then check the session before running authenticated tasks.
            </p>
          </div>
          <div className="auth-layout">
            {vendorSessionTools.map((tool) => (
              <VendorSessionCard
                key={tool.packId + '/' + tool.toolId + '/' + tool.packVersion}
                status={status}
                tasks={tasks}
                tool={tool}
                onOpenTasks={() => onNavigate('tasks')}
                onOpenDiagnostics={() => onNavigate('diagnostics')}
                dedicated={dedicatedSignInFor?.(tool)}
              />
            ))}
          </div>
        </section>
      )}
    </section>
  );
}

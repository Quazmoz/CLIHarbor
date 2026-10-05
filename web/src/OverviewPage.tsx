import { useMemo } from 'react';
import { VendorSessionCard } from './AuthenticationPage';
import type { RuntimeStatus } from './api/status';
import type { Task } from './api/tasks';
import type { ToolDiagnostic } from './api/tools';
import { taskIdentityKey, type TaskPreferences } from './taskPreferences';

export type OverviewDestination = 'authentication' | 'tasks' | 'runs' | 'diagnostics';

interface OverviewPageProps {
  status: RuntimeStatus;
  tasks: Task[];
  tools: ToolDiagnostic[];
  preferences: TaskPreferences;
  onNavigate: (destination: OverviewDestination) => void;
  onOpenTask: (taskKey: string) => void;
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
  const workflowReady = tools.length > 0 && attentionToolCount === 0 && tasks.length > 0;

  let recommendedTitle = 'Choose a safe task';
  let recommendedCopy = 'The local runtime has safe tasks available. Open Tasks to select, validate, preview, and run one.';
  let recommendedDestination: OverviewDestination = 'tasks';
  let recommendedAction = 'Open tasks';

  if (tools.length === 0) {
    recommendedTitle = 'Configure a reviewed CLI pack';
    recommendedCopy = 'No tools are configured yet. Diagnostics explains the trusted-pack and tool-readiness state without exposing execution paths.';
    recommendedDestination = 'diagnostics';
    recommendedAction = 'Open diagnostics';
  } else if (attentionToolCount > 0) {
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
          <p className="status-label">Your workspace</p>
          <h2 id="overview-heading">{workflowReady ? 'Ready for local operator work' : 'Local runtime is active'}</h2>
          <p>
            Your command-line tools, with a simpler way to work. Choose a task, review the inputs, and run it locally.
          </p>
        </div>
        {/* The primary action lives once, in "Recommended next step" below. */}
        {vendorSessionTools.length > 0 && (
          <div className="overview-hero-actions">
            <button type="button" className="secondary-button" onClick={() => onNavigate('authentication')}>
              Review authentication
            </button>
          </div>
        )}
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
          <p className="status-label">Recommended next step</p>
          <h2 id="next-step-heading">{recommendedTitle}</h2>
          <p>{recommendedCopy}</p>
          <div className="overview-panel-actions">
            <button type="button" onClick={() => onNavigate(recommendedDestination)}>
              {recommendedAction}
            </button>
            {tasks.length > 0 && recommendedDestination !== 'tasks' && (
              <button type="button" className="secondary-button" onClick={() => onNavigate('tasks')}>
                Browse available tasks
              </button>
            )}
          </div>
        </article>

        <article className="panel" aria-labelledby="quick-tasks-heading">
          <p className="status-label">Quick entry</p>
          <h2 id="quick-tasks-heading">Favorites & recent tasks</h2>
          {shortcuts.length === 0 ? (
            <div className="overview-empty">
              <p>Favorite a task or run one once and it will appear here for faster return access.</p>
              <div className="overview-panel-actions">
                <button type="button" className="secondary-button" onClick={() => onNavigate('tasks')}>
                  Browse tasks
                </button>
              </div>
            </div>
          ) : (
            <ul className="quick-task-list">
              {shortcuts.map((task) => (
                <li key={taskKey(task)}>
                  <button type="button" className="quick-task-button" onClick={() => onOpenTask(taskKey(task))}>
                    <strong>{task.name}</strong>
                    <span>{task.packName}{task.requiresAuth ? ' · Sign-in required' : ''}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </article>
      </div>

      {vendorSessionTools.length > 0 && (
        <section className="overview-login" aria-labelledby="overview-login-heading">
          <div className="route-heading">
            <p className="status-label">CLI sign-in</p>
            <h2 id="overview-login-heading">{hasGuidedCredentialLogin ? 'Sign in from CLIHarbor' : 'CLI authentication'}</h2>
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
              />
            ))}
          </div>
        </section>
      )}
    </section>
  );
}

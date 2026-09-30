import { useMemo } from 'react';
import type { Task } from './api/tasks';
import type { ToolDiagnostic } from './api/tools';
import { taskIdentityKey, type TaskPreferences } from './taskPreferences';

export type OverviewDestination = 'authentication' | 'tasks' | 'runs' | 'diagnostics';

interface OverviewPageProps {
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
  tasks,
  tools,
  preferences,
  onNavigate,
  onOpenTask,
}: OverviewPageProps) {
  const readyToolCount = tools.filter((tool) => tool.status === 'ready').length;
  const attentionToolCount = tools.length - readyToolCount;
  const vendorSessionTaskCount = tasks.filter((task) => task.requiresAuth === true).length;
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
          <p className="status-label">Operator home</p>
          <h2 id="overview-heading">{workflowReady ? 'Ready for local operator work' : 'Local runtime is active'}</h2>
          <p>
            Start from runtime readiness, move through vendor-session checks when needed, run only reviewed tasks, and keep
            execution evidence visible. CLIHarbor remains loopback-only and server-owned.
          </p>
        </div>
        <div className="overview-hero-actions">
          <button type="button" onClick={() => onNavigate(recommendedDestination)}>
            {recommendedAction}
          </button>
          <button type="button" className="secondary-button" onClick={() => onNavigate('authentication')}>
            Review authentication
          </button>
        </div>
      </div>

      <div className="overview-metrics" aria-label="Workspace summary">
        <div className="overview-metric">
          <span>Tool readiness</span>
          <strong>{readyToolCount}/{tools.length} ready</strong>
          <p>{tools.length === 0 ? 'No tools are configured.' : attentionToolCount === 0 ? 'No configured tool needs attention.' : attentionToolCount + ' tool state' + (attentionToolCount === 1 ? '' : 's') + ' need review.'}</p>
        </div>
        <div className="overview-metric">
          <span>Safe task catalog</span>
          <strong>{tasks.length} task{tasks.length === 1 ? '' : 's'}</strong>
          <p>{vendorSessionTaskCount} task{vendorSessionTaskCount === 1 ? '' : 's'} require a vendor-owned session.</p>
        </div>
        <div className="overview-metric">
          <span>Execution boundary</span>
          <strong>Local only</strong>
          <p>Browser choices stay inside the authenticated loopback runtime and reviewed pack authority.</p>
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
                    <span>{task.packName} · {task.toolId}{task.requiresAuth ? ' · vendor session' : ''}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </article>
      </div>

      <section className="panel" aria-labelledby="workflow-heading">
        <p className="status-label">Normal workflow</p>
        <h2 id="workflow-heading">From readiness to evidence</h2>
        <p>Each step has one job. Use the dedicated surface instead of hunting through one overloaded page.</p>
        <ol className="workflow-steps">
          <li className="workflow-step">
            <button type="button" onClick={() => onNavigate('diagnostics')}>
              <strong>Tools</strong>
              <span>{readyToolCount}/{tools.length} configured tools ready</span>
            </button>
          </li>
          <li className="workflow-step">
            <button type="button" onClick={() => onNavigate('authentication')}>
              <strong>Authentication</strong>
              <span>{vendorSessionTaskCount > 0 ? vendorSessionTaskCount + ' task' + (vendorSessionTaskCount === 1 ? ' declares' : 's declare') + ' vendor-session requirements' : 'Review vendor-session readiness when a pack requires it'}</span>
            </button>
          </li>
          <li className="workflow-step">
            <button type="button" onClick={() => onNavigate('tasks')}>
              <strong>Tasks</strong>
              <span>{tasks.length} reviewed browser-safe task{tasks.length === 1 ? '' : 's'} available</span>
            </button>
          </li>
          <li className="workflow-step">
            <button type="button" onClick={() => onNavigate('runs')}>
              <strong>Runs</strong>
              <span>Inspect bounded process-local history and retained evidence</span>
            </button>
          </li>
        </ol>
      </section>
    </section>
  );
}

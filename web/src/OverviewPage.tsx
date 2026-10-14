import { useEffect, useMemo, useState } from 'react';
import { VendorSessionCard, type DedicatedSignInLink } from './AuthenticationPage';
import { fetchRuns, type RunSummary } from './api/runs';
import type { RuntimeStatus } from './api/status';
import type { Task } from './api/tasks';
import type { ToolDiagnostic } from './api/tools';
import { runOutcomeHeading, runOutcomeTone } from './operatorLanguage';
import { formatDuration, taskName } from './RunsPage';
import { taskToolKey } from './TaskDiscovery';
import { taskIdentityKey, type TaskPreferences } from './taskPreferences';
import { toolStatusLabel } from './ToolExplorer';
import { ToolIcon } from './ToolIcon';

export type OverviewDestination = 'authentication' | 'tasks' | 'runs' | 'tools' | 'diagnostics';

interface OverviewPageProps {
  status: RuntimeStatus;
  tasks: Task[];
  tools: ToolDiagnostic[];
  preferences: TaskPreferences;
  onNavigate: (destination: OverviewDestination) => void;
  onOpenTask: (taskKey: string) => void;
  /** Opens the Command Builder filtered to one tool's tasks. */
  onOpenTool?: (toolKey: string) => void;
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

const ICONS = {
  terminal: 'M4 4h16v16H4z m4 5 3 3-3 3 M13 15h3',
  plus: 'M12 5v14 M5 12h14',
  history: 'M3 12a9 9 0 1 0 3-6 M3 3v6h6 M12 7v5l3 2',
  cube: 'M12 2 3 7v10l9 5 9-5V7z M3 7l9 5 9-5 M12 12v10',
  star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z',
  chevron: 'M9 6l6 6-6 6',
};

function Glyph({ d }: { d: string }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>;
}

function MetricCard({ icon, tone, label, value, detail, onClick }: {
  icon: string; tone: 'info' | 'positive' | 'warning'; label: string; value: number | string; detail: string; onClick: () => void;
}) {
  return (
    <button type="button" className="overview-metric" onClick={onClick}>
      <span className={'overview-metric-icon overview-metric-icon--' + tone}><Glyph d={icon} /></span>
      <span className="overview-metric-copy">
        <span className="overview-metric-label">{label}</span>
        <strong>{value}</strong>
        <span className="overview-metric-detail">{detail}</span>
      </span>
      <Glyph d={ICONS.chevron} />
    </button>
  );
}

function formatShortTime(value?: string): string {
  const date = value === undefined ? undefined : new Date(value);
  if (date === undefined || !Number.isFinite(date.getTime())) return 'Not started';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function OverviewPage({
  status,
  tasks,
  tools,
  preferences,
  onNavigate,
  onOpenTask,
  onOpenTool,
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
  const workflowReady = readyToolCount > 0 && tasks.length > 0;
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [runsFailed, setRunsFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetchRuns(controller.signal).then(setRuns, () => { if (!controller.signal.aborted) setRunsFailed(true); });
    return () => controller.abort();
  }, []);
  const recentRuns = useMemo(() => [...(runs ?? [])].sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? '')).slice(0, 5), [runs]);
  const succeeded = runs?.filter((run) => runOutcomeTone(run.status, run.exitCode) === 'succeeded').length ?? 0;
  const failed = runs?.filter((run) => runOutcomeTone(run.status, run.exitCode) === 'failed').length ?? 0;

  let recommendedTitle = 'Choose a safe task';
  let recommendedCopy = 'The local runtime has safe tasks available. Open the Command Builder to select, validate, preview, and run one.';
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

  const steps = [
    { label: 'Add a CLI', detail: 'Install a reviewed CLI or load a pack.', done: tools.length > 0, destination: 'tools' as const },
    { label: 'Get tools ready', detail: 'Resolve any tool that needs setup.', done: readyToolCount > 0, destination: 'diagnostics' as const },
    { label: 'Build a command', detail: 'Pick an approved task and fill it in.', done: preferences.recent.length > 0 || (runs?.length ?? 0) > 0, destination: 'tasks' as const },
    { label: 'Run safely', detail: 'Review preflight checks, then run.', done: succeeded > 0, destination: 'tasks' as const },
  ];
  const currentStep = steps.findIndex((step) => !step.done);

  return (
    <section className="overview-page" aria-labelledby="overview-heading">
      <header className="overview-hero">
        <div className="overview-hero-copy">
          <p className="status-label">Welcome to CLIHarbor</p>
          <h2 id="overview-heading">{workflowReady ? 'What would you like to do?' : 'Get your CLIs ready'}</h2>
          <p>{workflowReady ? 'Pick an approved task, set up another CLI, or review what ran.' : 'Get your CLIs ready, then run approved tasks safely.'} Every command runs locally on this computer.</p>
        </div>
        <div className="overview-hero-actions">
          <button type="button" onClick={() => onNavigate(recommendedDestination)}>
            <Glyph d={ICONS.terminal} />{recommendedAction}
          </button>
          <button type="button" className="secondary-button" onClick={() => onNavigate('tools')}><Glyph d={ICONS.plus} />Add a CLI</button>
          <button type="button" className="secondary-button" onClick={() => onNavigate('runs')}><Glyph d={ICONS.history} />View history</button>
        </div>
      </header>

      <div className="overview-metrics" aria-label="Workspace summary">
        <MetricCard icon={ICONS.cube} tone="info" label="Tools" value={tools.length}
          detail={tools.length === 0 ? 'No tools are configured.' : `${readyToolCount} ready` + (attentionToolCount === 0 ? '' : ` · ${attentionToolCount} need${attentionToolCount === 1 ? 's' : ''} setup`)}
          onClick={() => onNavigate('diagnostics')} />
        <MetricCard icon={ICONS.terminal} tone="positive" label="Available tasks" value={tasks.length}
          detail={vendorSessionTaskCount === 0 ? 'None require sign-in.' : `${vendorSessionTaskCount} require${vendorSessionTaskCount === 1 ? 's' : ''} sign-in`}
          onClick={() => onNavigate('tasks')} />
        <MetricCard icon={ICONS.star} tone="warning" label="Favorites" value={preferences.favorites.length}
          detail="Pinned tasks for quick return" onClick={() => onNavigate('tasks')} />
        <MetricCard icon={ICONS.history} tone="info" label="Recent executions" value={runs === null ? '—' : runs.length}
          detail={runs === null ? (runsFailed ? 'History unavailable' : 'Loading…') : `${succeeded} succeeded · ${failed} failed · ${runs.length - succeeded - failed} other`}
          onClick={() => onNavigate('runs')} />
      </div>

      <div className="overview-grid">
        <article className="panel overview-card" aria-labelledby="overview-tools-heading">
          <div className="overview-card-heading">
            <h2 id="overview-tools-heading">Tool status</h2>
            <button type="button" className="link-button" onClick={() => onNavigate('diagnostics')}>View all tools →</button>
          </div>
          {tools.length === 0 ? (
            <p className="overview-muted">No tools are configured. Add a CLI to get started.</p>
          ) : (
            <>
              <div className="overview-tool-row overview-tool-row--head" aria-hidden="true"><span>Tool</span><span>Version</span><span>Status</span><span>Tasks</span></div>
              <ul className="overview-tool-list">
                {tools.slice(0, 8).map((tool) => {
                  const key = taskToolKey(tool);
                  const count = tasks.filter((task) => taskToolKey(task) === key).length;
                  const status = toolStatusLabel(tool);
                  return (
                    <li key={key}>
                      <button type="button" className="overview-tool-row"
                        onClick={() => (tool.status === 'ready' && count > 0 && onOpenTool ? onOpenTool(key) : onNavigate(tool.status === 'missing' ? 'tools' : 'diagnostics'))}>
                        <span className="overview-tool-name"><ToolIcon tool={tool} size="sm" /><strong>{tool.packName}</strong></span>
                        <span className="overview-muted">{tool.version ?? '—'}</span>
                        <span className={'overview-status overview-status--' + status.tone}>{status.label}</span>
                        <span>{count}</span>
                        <Glyph d={ICONS.chevron} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </article>

        <article className="panel overview-card" aria-labelledby="overview-runs-heading">
          <div className="overview-card-heading">
            <h2 id="overview-runs-heading">Recent executions</h2>
            <button type="button" className="link-button" onClick={() => onNavigate('runs')}>View all →</button>
          </div>
          {runs === null ? (
            <p className="overview-muted">{runsFailed ? 'Execution history is unavailable right now.' : 'Loading recent executions…'}</p>
          ) : recentRuns.length === 0 ? (
            <p className="overview-muted">No tasks have run yet. Runs you start appear here.</p>
          ) : (
            <ol className="overview-timeline">
              {recentRuns.map((run) => {
                const tone = runOutcomeTone(run.status, run.exitCode);
                const tool = tools.find((candidate) => taskToolKey(candidate) === taskToolKey(run));
                return (
                  <li key={run.runId} className={'overview-timeline-item overview-timeline-item--' + tone}>
                    <button type="button" onClick={() => onNavigate('runs')}>
                      <ToolIcon tool={{ packId: run.packId, packName: tool?.packName ?? '', toolId: run.toolId }} />
                      <span className="overview-timeline-copy">
                        <strong>{taskName(run, tasks)}</strong>
                        <span>{tool?.packName ?? run.toolId} · {formatShortTime(run.startedAt)}</span>
                      </span>
                      <span className="overview-muted">{formatDuration(run.startedAt, run.endedAt)}</span>
                      <span className={'run-history-status run-history-status--' + tone}>{runOutcomeHeading(run.status, run.exitCode)}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </article>
      </div>

      <div className="overview-grid overview-grid--secondary">
        <article className="panel overview-card" aria-labelledby="next-step-heading">
          <p className="status-label">Next step</p>
          <h2 id="next-step-heading">{recommendedTitle}</h2>
          <p className="overview-muted">{recommendedCopy}</p>
          <ol className="overview-steps" aria-label="Getting started">
            {steps.map((step, index) => (
              <li key={step.label} aria-current={index === currentStep ? 'step' : undefined}
                className={step.done ? 'overview-step overview-step--done' : 'overview-step'}>
                <button type="button" onClick={() => onNavigate(step.destination)}>
                  <span className="overview-step-marker" aria-hidden="true">{step.done ? '✓' : index + 1}</span>
                  <strong>{step.label}</strong>
                  <span>{step.detail}</span>
                  <span className="visually-hidden">{step.done ? '(done)' : index === currentStep ? '(current)' : ''}</span>
                </button>
              </li>
            ))}
          </ol>
        </article>

        <article className="panel overview-card" aria-labelledby="quick-tasks-heading">
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
                    <ToolIcon tool={task} />
                    <span className="overview-timeline-copy">
                      <strong>{task.name}</strong>
                      <span>{task.packName}{task.requiresAuth ? ' · Sign-in required' : ''}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </article>

        <article className="panel overview-card" aria-labelledby="overview-workspace-heading">
          <h2 id="overview-workspace-heading">Workspace</h2>
          <dl className="overview-facts">
            <div><dt>Runtime</dt><dd>{status.name} {status.version}</dd></div>
            <div><dt>Session</dt><dd>{status.session === 'active' ? 'Active' : status.session}</dd></div>
            <div><dt>Execution</dt><dd>Local only</dd></div>
            <div><dt>Credentials</dt><dd>Vendor-owned storage</dd></div>
          </dl>
        </article>
      </div>

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

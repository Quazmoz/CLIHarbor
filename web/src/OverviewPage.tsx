import { useEffect, useMemo, useState } from 'react';
import { fetchRuns, type RunSummary } from './api/runs';
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

const ICONS = {
  terminal: 'M4 4h16v16H4z m4 5 3 3-3 3 M13 15h3',
  plus: 'M12 5v14 M5 12h14',
  chevron: 'M9 6l6 6-6 6',
};

function Glyph({ d }: { d: string }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>;
}

function startedAtMillis(value?: string): number {
  const millis = value === undefined ? Number.NaN : Date.parse(value);
  return Number.isFinite(millis) ? millis : Number.NEGATIVE_INFINITY;
}

// Sort by instant, not by string: RFC 3339 strings with different offsets or
// fractional-second precision do not order lexically. Unparseable or missing
// timestamps sink to the end instead of jumping to the top.
export function newestFirst<T extends { startedAt?: string }>(runs: readonly T[]): T[] {
  return [...runs].sort((a, b) => {
    const delta = startedAtMillis(b.startedAt) - startedAtMillis(a.startedAt);
    return Number.isNaN(delta) ? 0 : delta;
  });
}

function formatShortTime(value?: string): string {
  const date = value === undefined ? undefined : new Date(value);
  if (date === undefined || !Number.isFinite(date.getTime())) return 'Not started';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function OverviewPage({
  tasks,
  tools,
  preferences,
  onNavigate,
  onOpenTask,
}: OverviewPageProps) {
  const readyToolCount = tools.filter((tool) => tool.status === 'ready').length;
  const attentionTools = tools.filter((tool) => tool.status !== 'ready');
  const attentionToolCount = attentionTools.length;
  const shortcuts = useMemo(() => quickTasks(tasks, preferences), [tasks, preferences]);
  const workflowReady = readyToolCount > 0 && tasks.length > 0;
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [runsFailed, setRunsFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetchRuns(controller.signal).then(setRuns, () => { if (!controller.signal.aborted) setRunsFailed(true); });
    return () => controller.abort();
  }, []);
  const recentRuns = useMemo(() => newestFirst(runs ?? []).slice(0, 5), [runs]);
  const succeeded = runs?.filter((run) => runOutcomeTone(run.status, run.exitCode) === 'succeeded').length ?? 0;

  let recommendedTitle = 'Choose a safe task';
  let recommendedCopy = 'Choose a task in Command Builder, review its inputs, and run it.';
  let recommendedDestination: OverviewDestination = 'tasks';
  let recommendedAction = 'Open tasks';

  if (tools.length === 0) {
    recommendedTitle = 'Configure a reviewed CLI pack';
    recommendedCopy = 'No tools are configured yet. Add a CLI to get started.';
    recommendedDestination = 'tools';
    recommendedAction = 'Add a CLI';
  } else if (attentionToolCount > 0 && tasks.length === 0) {
    recommendedTitle = 'Resolve tool readiness';
    recommendedCopy = 'Set up a CLI to make its approved tasks available.';
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
          {!workflowReady && <h3>{recommendedTitle}</h3>}
          <p>{recommendedCopy}</p>
        </div>
        <div className="overview-hero-actions">
          <button type="button" onClick={() => onNavigate(recommendedDestination)}>
            <Glyph d={ICONS.terminal} />{recommendedAction}
          </button>
          {recommendedDestination !== 'tools' && <button type="button" className="secondary-button" onClick={() => onNavigate('tools')}><Glyph d={ICONS.plus} />Add a CLI</button>}
        </div>
      </header>

      <div className="overview-grid">
        {attentionTools.length > 0 && (
          <article className="panel overview-card" aria-labelledby="overview-tools-heading">
            <div className="overview-card-heading">
              <h2 id="overview-tools-heading">Tools needing attention</h2>
              <button type="button" className="link-button" onClick={() => onNavigate('diagnostics')}>Review tools →</button>
            </div>
            <ul className="overview-tool-list">
              {attentionTools.map((tool) => {
                const status = toolStatusLabel(tool);
                return (
                  <li key={taskToolKey(tool)}>
                    <button type="button" className="overview-tool-row"
                      onClick={() => onNavigate(tool.status === 'missing' ? 'tools' : 'diagnostics')}>
                      <span className="overview-tool-name"><ToolIcon tool={tool} size="sm" /><strong>{tool.packName} · {tool.toolId}</strong></span>
                      <span className={'overview-status overview-status--' + status.tone}>{status.label}</span>
                      <Glyph d={ICONS.chevron} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </article>
        )}

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

        {!workflowReady && preferences.recent.length === 0 && runs?.length === 0 && (
          <article className="panel overview-card" aria-labelledby="next-step-heading">
            <h2 id="next-step-heading">Getting started</h2>
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
        )}

        <article className="panel overview-card" aria-labelledby="quick-tasks-heading">
          <h2 id="quick-tasks-heading">Favorites & recent tasks</h2>
          {shortcuts.length === 0 ? (
            <div className="overview-empty">
              <p>Favorite a task or run one once and it will appear here for faster return access.</p>
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
      </div>
    </section>
  );
}

import type { Platform, PlatformFeatureID } from './api/platforms';
import type { ToolDiagnostic } from './api/tools';
import type { Task } from './api/tasks';
import { ConjurWorkspace } from './platforms/conjur/ConjurWorkspace';

interface PlatformPageProps {
  platform: Platform;
  tasks: Task[];
  tools?: ToolDiagnostic[];
  csrfToken?: string;
  onOpenRuns?: () => void;
  onOpenFeature: (feature: PlatformFeatureID) => void;
  onOpenDiagnostics: () => void;
  onOpenTask: (taskKey: string, prefill?: Record<string, string>) => void;
}

const featureDetail: Record<PlatformFeatureID, string> = {
  tasks: 'Approved commands from the reviewed pack, with target context shown before any change runs.',
  'sign-in': 'Guided sign-in that keeps the session owned by the vendor CLI.',
  'security-audit': 'Custom regex explorer with metadata-only inventory presets and opt-in secret-value matching.',
  'access-explorer': 'Read-only resource and role navigation with bounded inventory and clearly labeled permission relationships.',
};

/** Home for one dedicated CLI: what CLIHarbor adds on top of the generic workspace. */
export function PlatformPage({ platform, tasks, tools = [], csrfToken, onOpenRuns, onOpenFeature, onOpenDiagnostics, onOpenTask }: PlatformPageProps) {
  const tool = tools.find((candidate) => candidate.packId === platform.packId && candidate.toolId === platform.toolId);
  const taskCount = tasks.filter((task) => task.packId === platform.packId && task.toolId === platform.toolId).length;
  return (
    <section className="panel platform-page" aria-labelledby="platform-heading">
      <p className="status-label">Built-in CLI</p>
      <h2 id="platform-heading">{platform.name}</h2>
      <p>{platform.summary}</p>
      {platform.id === 'conjur' ? (
        <ConjurWorkspace platform={platform} tasks={tasks} tool={tool} csrfToken={csrfToken} onOpenRuns={onOpenRuns}
          onOpenFeature={onOpenFeature} onOpenDiagnostics={onOpenDiagnostics} onOpenTask={onOpenTask} />
      ) : (
        <>
          <p role="status">
            {platform.ready
              ? <><strong>CLI discovery ready.</strong> Verify the vendor session and backend permissions before using these workflows.</>
              : <><strong>Setup needed.</strong> Check tool readiness before using this integration.</>}
          </p>
          {!platform.ready && (
            <button type="button" className="secondary-button" onClick={onOpenDiagnostics}>Open Diagnostics</button>
          )}
          <ul className="platform-features">
            {platform.features.map((feature) => (
              <li key={feature.id}>
                <h3>{feature.name}</h3>
                <p>{featureDetail[feature.id]}{feature.id === 'tasks' ? ` ${taskCount} available.` : ''}</p>
                <button type="button" className={feature.id === 'tasks' ? undefined : 'secondary-button'}
                  onClick={() => onOpenFeature(feature.id)}
                  disabled={feature.id === 'tasks' && taskCount === 0}>
                  {feature.id === 'tasks' ? 'Browse ' + taskCount + ' approved tasks' :
                    feature.id === 'sign-in' ? 'Open sign-in' : feature.id === 'access-explorer' ? 'Open Access Explorer' : 'Open security audit'}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

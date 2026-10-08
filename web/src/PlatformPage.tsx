import type { Platform, PlatformFeatureID } from './api/platforms';
import type { Task } from './api/tasks';

interface PlatformPageProps {
  platform: Platform;
  tasks: Task[];
  onOpenFeature: (feature: PlatformFeatureID) => void;
  onOpenDiagnostics: () => void;
  onOpenTask: (taskKey: string) => void;
}

const featureDetail: Record<PlatformFeatureID, string> = {
  tasks: 'Approved commands from the reviewed pack, with target context shown before any change runs.',
  'sign-in': 'Guided sign-in that keeps the session owned by the vendor CLI.',
  'security-audit': 'Custom regex explorer with metadata-only inventory presets and opt-in secret-value matching.',
  'access-explorer': 'Read-only resource and role navigation with bounded inventory and clearly labeled permission relationships.',
};

/** Home for one dedicated CLI: what CLIHarbor adds on top of the generic workspace. */
export function PlatformPage({ platform, tasks, onOpenFeature, onOpenDiagnostics, onOpenTask }: PlatformPageProps) {
  const platformTasks = tasks.filter((task) => task.packId === platform.packId && task.toolId === platform.toolId);
  const taskCount = platformTasks.length;
  // All shortcuts are resolved from backend-advertised approved tasks, never
  // from an independent command list that could bypass runtime policy.
  const groups = [
    { name: 'Resource inventory', ids: ['list-variables', 'list-policies', 'list-hosts', 'list-groups', 'list-resources', 'count-resources'] },
    { name: 'Access inspection', ids: ['resource-show', 'resource-permitted-roles', 'role-show', 'role-members', 'role-memberships'] },
    { name: 'Reviewed changes', ids: ['secret-create', 'secret-delete', 'secret-permit', 'secret-deny', 'secret-set-value'] },
  ];
  return (
    <section className="panel platform-page" aria-labelledby="platform-heading">
      <p className="status-label">Built-in CLI</p>
      <h2 id="platform-heading">{platform.name}</h2>
      <p>{platform.summary}</p>
      <p role="status">
        {platform.ready
          ? <><strong>CLI ready.</strong> Everything below is built and tested for this CLI.</>
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
      {platform.id === 'conjur' && (
        <section className="platform-toolbox" aria-label="Conjur toolbox">
          <div className="route-heading">
            <p className="status-label">Conjur toolbox</p>
            <h2>Quick tools</h2>
            <p>Open approved Conjur commands directly in the existing task form. No command runs until reviewed and started.</p>
          </div>
          {groups.map((group) => {
            const available = group.ids.flatMap((id) => platformTasks.filter((task) => task.commandId === id));
            return available.length === 0 ? null : (
              <section key={group.name} aria-label={group.name} className="platform-toolbox-section">
                <h3>{group.name}</h3>
                <div className="platform-toolbox-grid">
                  {available.map((task) => (
                    <button key={task.packId + '/' + task.commandId} type="button" className="platform-tool-button"
                      onClick={() => onOpenTask(task.packId + '/' + task.commandId)}>
                      <strong>{task.name}</strong>
                      <span>{task.description ?? 'Open approved CLI workflow'}</span>
                      <small>{task.risk === 'read' ? 'Read-only' : 'Approval required'}</small>
                    </button>
                  ))}
                </div>
              </section>
            );
          })}
        </section>
      )}
    </section>
  );
}

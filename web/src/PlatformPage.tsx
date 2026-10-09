import { useEffect, useState } from 'react';
import type { Platform, PlatformFeatureID } from './api/platforms';
import type { ToolDiagnostic } from './api/tools';
import { fetchSecretAudit } from './platforms/conjur/secretAuditApi';
import type { Task } from './api/tasks';
import { ConjurMigrationWorkbench } from './platforms/conjur/ConjurMigrationWorkbench';

interface PlatformPageProps {
  platform: Platform;
  tasks: Task[];
  tools?: ToolDiagnostic[];
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
export function PlatformPage({ platform, tasks, tools = [], onOpenRuns, onOpenFeature, onOpenDiagnostics, onOpenTask }: PlatformPageProps) {
  const tool = tools.find((candidate) => candidate.packId === platform.packId && candidate.toolId === platform.toolId);
  const readiness = tool?.status ?? 'unavailable';
  const [migrationOpen, setMigrationOpen] = useState(false);
  const [targetSnapshot, setTargetSnapshot] = useState<{
    platformId: string; readiness: string; applianceUrl: string; account: string;
  } | null>(null);
  // Never render an environment snapshot obtained under a different platform or
  // discovery state, even for the frame before an effect processes new props.
  const target = targetSnapshot?.platformId === platform.id && targetSnapshot.readiness === readiness
    ? targetSnapshot : null;
  useEffect(() => {
    if (platform.id !== 'conjur') return;
    const controller = new AbortController();
    void fetchSecretAudit(controller.signal).then((audit) => {
      if (!controller.signal.aborted) {
        setTargetSnapshot(audit.available && audit.target
          ? { ...audit.target, platformId: platform.id, readiness }
          : null);
      }
    }).catch(() => { if (!controller.signal.aborted) setTargetSnapshot(null); });
    return () => controller.abort();
  }, [platform.id, readiness]);
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
          ? <><strong>CLI discovery ready.</strong> Verify the vendor session and backend permissions before using these workflows.</>
          : <><strong>Setup needed.</strong> Check tool readiness before using this integration.</>}
      </p>
      {!platform.ready && (
        <button type="button" className="secondary-button" onClick={onOpenDiagnostics}>Open Diagnostics</button>
      )}
      {platform.id === 'conjur' && <section className="platform-toolbox-section" aria-label="Conjur environment">
        <h3>Operations overview</h3>
        <dl>
          <div><dt>CLI discovery</dt><dd>{tool?.status ?? (platform.ready ? 'Ready' : 'Not ready')}</dd></div>
          <div><dt>CLI version</dt><dd>{tool?.version ?? 'Not verified'}</dd></div>
          <div><dt>Configured endpoint</dt><dd>{target?.applianceUrl ?? 'Not available'}</dd></div>
          <div><dt>Configured account</dt><dd>{target?.account ?? 'Not available'}</dd></div>
          <div><dt>Authenticated identity</dt><dd>Verify on Conjur sign-in / session</dd></div>
          <div><dt>Session</dt><dd>Not inferred from CLI discovery; check the vendor session</dd></div>
        </dl>
        <div className="platform-toolbox-grid">
          <button type="button" className="secondary-button" onClick={() => onOpenFeature('access-explorer')}>Access &amp; permissions</button>
          <button type="button" className="secondary-button" onClick={() => onOpenFeature('security-audit')}>Regex pattern explorer</button>
          <button type="button" className="secondary-button" onClick={() => {
            setMigrationOpen(true);
            document.getElementById('conjur-migration')?.scrollIntoView?.({ block: 'start' });
          }}>Migration playbooks &amp; templates</button>
          <button type="button" className="secondary-button" onClick={() => onOpenFeature('tasks')}>Inventory &amp; approved changes</button>
          <button type="button" className="secondary-button" onClick={() => onOpenFeature('sign-in')}>Session check</button>
          {onOpenRuns && <button type="button" className="secondary-button" onClick={onOpenRuns}>Runs &amp; mutation audit</button>}
          <button type="button" className="secondary-button" onClick={onOpenDiagnostics}>Diagnostics</button>
        </div>
      </section>}
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
        <details id="conjur-migration" className="platform-toolbox conjur-migration-details"
          open={migrationOpen} onToggle={(event) => setMigrationOpen(event.currentTarget.open)}>
          <summary>Migration playbooks &amp; policy templates</summary>
          <ConjurMigrationWorkbench tasks={platformTasks} packId={platform.packId}
            toolId={platform.toolId} onOpenTask={onOpenTask} />
        </details>
      )}
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

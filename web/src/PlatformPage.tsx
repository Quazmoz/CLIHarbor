import { useEffect, useState } from 'react';
import type { Platform, PlatformFeatureID } from './api/platforms';
import type { ToolDiagnostic } from './api/tools';
import { fetchSecretAudit } from './platforms/conjur/secretAuditApi';
import type { Task } from './api/tasks';
import { ConjurMigrationWorkbench } from './platforms/conjur/ConjurMigrationWorkbench';
import { ConjurCreateSecret } from './platforms/conjur/ConjurCreateSecret';

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
  // A ready CLI may still switch version, pack contract, or login capability.
  // Never show the previous vendor endpoint under a changed discovery context.
  const discoveryKey = JSON.stringify([
    platform.id, platform.packId, platform.toolId, platform.ready,
    tool?.status, tool?.packVersion, tool?.version, tool?.versionConstraint,
    tool?.requiresVendorSession, tool?.sessionCheck?.commandId,
    tool?.credentialLogin?.method,
    tool?.credentialLogin?.method === 'conjur-password' ? tool.credentialLogin.setupRequired : undefined,
  ]);
  const [migrationOpen, setMigrationOpen] = useState(false);
  const [targetSnapshot, setTargetSnapshot] = useState<{
    discoveryKey: string; applianceUrl: string; account: string;
  } | null>(null);
  // Never render an environment snapshot obtained under a different platform or
  // discovery state, even for the frame before an effect processes new props.
  const target = targetSnapshot?.discoveryKey === discoveryKey ? targetSnapshot : null;
  useEffect(() => {
    if (platform.id !== 'conjur') return;
    const controller = new AbortController();
    void fetchSecretAudit(controller.signal).then((audit) => {
      if (!controller.signal.aborted) {
        setTargetSnapshot(audit.available && audit.target &&
          audit.packId === platform.packId && audit.toolId === platform.toolId
          ? { ...audit.target, discoveryKey }
          : null);
      }
    }).catch(() => { if (!controller.signal.aborted) setTargetSnapshot(null); });
    return () => controller.abort();
  }, [platform.id, platform.packId, platform.toolId, discoveryKey]);
  const platformTasks = tasks.filter((task) => task.packId === platform.packId && task.toolId === platform.toolId);
  const taskCount = platformTasks.length;
  const permissionTasks = new Map(platformTasks.filter((task) =>
    task.risk === 'change' && ['secret-permit', 'secret-deny'].includes(task.commandId),
  ).map((task) => [task.commandId, task]));
  const permissionReady = platform.ready && (tool === undefined || tool.status === 'ready');
  const explorerAvailable = permissionReady && platform.features.some((feature) => feature.id === 'access-explorer');
  // All shortcuts are resolved from backend-advertised approved tasks, never
  // from an independent command list that could bypass runtime policy.
  const groups = [
    { name: 'Resource inventory', ids: ['list-variables', 'list-policies', 'list-hosts', 'list-groups', 'list-resources', 'count-resources'] },
    { name: 'Access inspection', ids: ['resource-show', 'resource-permitted-roles', 'role-show', 'role-members', 'role-memberships'] },
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
      {platform.id === 'conjur' && (
        <section className="conjur-crud-panel" aria-label="Conjur secret management">
          <div className="route-heading">
            <p className="status-label">Secret management · CRUD</p>
            <h3>Manage secrets</h3>
            <p>Create a secret with its initial value in one form, browse variable IDs, update a value, or delete a variable. Changes use reviewed commands and require approval; viewing values is intentionally unavailable.</p>
          </div>
          <div className="conjur-crud-grid">
            {csrfToken ? (
              <ConjurCreateSecret key={discoveryKey + '/' + (target?.account ?? '') + '/' + (target?.applianceUrl ?? '')}
                tasks={platformTasks} csrfToken={csrfToken} account={permissionReady ? target?.account : undefined}
                contextKey={discoveryKey + '/' + (target?.applianceUrl ?? '') + '/' + (target?.account ?? '')} />
            ) : <div className="platform-tool-button"><strong>Create secret</strong><span>Requires a verified browser session.</span></div>}
            {([
              { id: 'list-variables', risk: 'read', title: 'Read / browse', description: 'Find visible variable IDs without exposing their stored values.' },
              { id: 'secret-set-value', risk: 'change', title: 'Update value', description: 'Rotate or replace an existing value through secure stdin.' },
              { id: 'secret-delete', risk: 'destructive', title: 'Delete secret', description: 'Permanently remove a variable and its stored versions after typed approval.' },
            ] as const).map((action) => {
              const task = platformTasks.find((candidate) => candidate.commandId === action.id &&
                candidate.risk === action.risk);
              const available = permissionReady && task !== undefined;
              return <button key={action.id} type="button" className="platform-tool-button"
                disabled={!available}
                onClick={() => { if (available) onOpenTask(task.packId + '/' + task.commandId); }}>
                <strong>{action.title}</strong>
                <span>{action.description}</span>
                <small>{available ? (action.risk === 'read' ? 'Read-only metadata' : 'Approval required') : 'Unavailable until the approved task is ready'}</small>
              </button>;
            })}
          </div>
        </section>
      )}
      {platform.id === 'conjur' && (
        <section className="conjur-permission-panel" aria-label="Conjur permission management">
          <div className="route-heading">
            <p className="status-label">Primary workflow · Secret variables</p>
            <h3>Manage secret permissions</h3>
            <p>Grant, revoke, or review Conjur variable permissions. Policy changes require a separate preview and approval in the task runner.</p>
          </div>
          <div className="conjur-permission-grid">
            <button type="button" className="platform-tool-button conjur-permission-action"
              disabled={!permissionReady || !permissionTasks.has('secret-permit')}
              onClick={() => {
                const task = permissionTasks.get('secret-permit');
                if (permissionReady && task) onOpenTask(task.packId + '/' + task.commandId);
              }}>
              <strong>Grant permission</strong>
              <span>Allow a selected host, group, layer, or user to read, execute, or update a secret variable.</span>
              <small>{permissionReady && permissionTasks.has('secret-permit') ? 'Open grant form · Approval required' : 'Unavailable until the approved task is ready'}</small>
            </button>
            <button type="button" className="platform-tool-button conjur-permission-action"
              disabled={!permissionReady || !permissionTasks.has('secret-deny')}
              onClick={() => {
                const task = permissionTasks.get('secret-deny');
                if (permissionReady && task) onOpenTask(task.packId + '/' + task.commandId);
              }}>
              <strong>Revoke permission</strong>
              <span>Remove selected variable privileges granted by the same policy branch. Verify the original granting branch.</span>
              <small>{permissionReady && permissionTasks.has('secret-deny') ? 'Open revoke form · Approval required' : 'Unavailable until the approved task is ready'}</small>
            </button>
            <button type="button" className="platform-tool-button conjur-permission-action"
              disabled={!explorerAvailable}
              onClick={() => { if (explorerAvailable) onOpenFeature('access-explorer'); }}>
              <strong>Change permissions</strong>
              <span>Inspect Conjur-reported access, then open separate grant or revoke approvals. No automatic permission swap.</span>
              <small>{explorerAvailable ? 'Review access first · Read-only inspection' : 'Unavailable until Access Explorer is ready'}</small>
            </button>
          </div>
        </section>
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
          <ConjurMigrationWorkbench key={discoveryKey} tasks={platformTasks} packId={platform.packId}
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

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { Platform, PlatformFeatureID } from '../../api/platforms';
import type { Task } from '../../api/tasks';
import type { ToolDiagnostic } from '../../api/tools';
import { fetchSecretAudit } from './secretAuditApi';
import { ConjurCreateSecret } from './ConjurCreateSecret';
import { ConjurManagePermissions } from './ConjurManagePermissions';
import { ConjurMigrationWorkbench } from './ConjurMigrationWorkbench';
import { ConjurTaskPanel } from './ConjurTaskPanel';
import { useOperationActivity } from '../../OperationActivity';

export interface ConjurTaskRequest { commandId: string; values?: Record<string, string>; sequence: number }

interface Props {
  platform: Platform;
  tasks: Task[];
  tool?: ToolDiagnostic;
  csrfToken?: string;
  onOpenRuns?: () => void;
  onOpenFeature: (feature: PlatformFeatureID) => void;
  onOpenDiagnostics: () => void;
  onOpenTask: (taskKey: string, prefill?: Record<string, string>) => void;
  requestedTask?: ConjurTaskRequest;
  onTaskRequestHandled?: () => void;
}

type Risk = Task['risk'];
const riskLabel: Record<Risk, string> = { read: 'Read-only', change: 'Approval required', destructive: 'Destructive · approval required' };
const tabs = [
  { id: 'secrets', label: 'Secrets' },
  { id: 'access', label: 'Access' },
  { id: 'audit', label: 'Audit' },
  { id: 'tools', label: 'Tools' },
] as const;
type TabID = (typeof tabs)[number]['id'];
const accessInspection = ['resource-show', 'resource-permitted-roles', 'role-show', 'role-members', 'role-memberships'];
// list-variables already has its canonical home as Secrets › Browse variables.
const resourceInventory = ['list-policies', 'list-hosts', 'list-groups', 'list-resources', 'count-resources'];
const createCommands = ['secret-create', 'secret-create-owned'];
const permissionCommands = ['secret-permit', 'secret-deny'];
const tabForCommand = (id: string): TabID => permissionCommands.includes(id) || accessInspection.includes(id) || id.startsWith('role-') || id === 'resource-exists'
  ? 'access' : id.startsWith('secret-') || id === 'list-variables' ? 'secrets' : 'tools';

/** One compact, full-row action. The title is the accessible name; detail and risk describe it. */
function Action({ title, detail, risk, available, onOpen }: {
  title: string; detail: string; risk?: Risk; available: boolean; onOpen: () => void;
}) {
  const id = useId();
  return (
    <button type="button" className={'conjur-action' + (risk ? ' conjur-action--' + risk : '')} disabled={!available}
      aria-label={title} aria-describedby={risk ? id + ' ' + id + '-risk' : id} onClick={() => { if (available) onOpen(); }}>
      <span className="conjur-action-text">
        <strong>{title}</strong>
        <span id={id}>{available ? detail : detail + ' Unavailable until the CLI and approved task are ready.'}</span>
      </span>
      {risk && <span id={id + '-risk'} className={'task-risk-badge task-risk-badge--' + risk}>{riskLabel[risk]}</span>}
    </button>
  );
}

/** Conjur's dedicated home: environment context first, then one focused workflow per tab. */
export function ConjurWorkspace({ platform, tasks, tool, csrfToken, onOpenRuns, onOpenFeature, onOpenDiagnostics, requestedTask, onTaskRequestHandled }: Props) {
  const { local } = useOperationActivity();
  const workspaceBusy = Object.values(local).some((work) => work.path === window.location.pathname && work.anchor?.startsWith('conjur-'));
  const sequence = useRef(requestedTask?.sequence ?? 0);
  const [choice, setChoice] = useState(requestedTask?.commandId ?? '');
  const [createRequest, setCreateRequest] = useState<ConjurTaskRequest | null>(requestedTask && createCommands.includes(requestedTask.commandId) ? requestedTask : null);
  const [permissionRequest, setPermissionRequest] = useState<ConjurTaskRequest | null>(requestedTask && permissionCommands.includes(requestedTask.commandId) ? requestedTask : null);
  const [action, setAction] = useState<ConjurTaskRequest | null>(requestedTask && !createCommands.includes(requestedTask.commandId) && !permissionCommands.includes(requestedTask.commandId) ? requestedTask : null);
  useEffect(() => { if (requestedTask) onTaskRequestHandled?.(); }, [requestedTask, onTaskRequestHandled]);
  // A ready CLI may still switch version, pack contract, or login capability.
  // Never show the previous vendor endpoint under a changed discovery context.
  const discoveryKey = JSON.stringify([
    platform.id, platform.packId, platform.toolId, platform.ready,
    tool?.status, tool?.packVersion, tool?.version, tool?.versionConstraint,
    tool?.requiresVendorSession, tool?.sessionCheck?.commandId,
    tool?.credentialLogin?.method,
    tool?.credentialLogin?.method === 'conjur-password' ? tool.credentialLogin.setupRequired : undefined,
  ]);
  const [tab, setTab] = useState<TabID>(requestedTask ? tabForCommand(requestedTask.commandId) : 'secrets');
  const [targetSnapshot, setTargetSnapshot] = useState<{
    discoveryKey: string; applianceUrl: string; account: string;
  } | null>(null);
  // Never render an environment snapshot obtained under a different platform or
  // discovery state, even for the frame before an effect processes new props.
  const target = targetSnapshot?.discoveryKey === discoveryKey ? targetSnapshot : null;
  // The vendor CLI can rewrite ~/.conjurrc without changing discovery, e.g. while
  // the operator is in a terminal. Re-read the backend's target on return.
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const returned = () => { if (document.visibilityState === 'visible') setRefresh((value) => value + 1); };
    window.addEventListener('focus', returned);
    document.addEventListener('visibilitychange', returned);
    return () => {
      window.removeEventListener('focus', returned);
      document.removeEventListener('visibilitychange', returned);
    };
  }, []);
  useEffect(() => {
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
  }, [platform.packId, platform.toolId, discoveryKey, refresh]);

  const ready = platform.ready && (tool === undefined || tool.status === 'ready');
  const hasFeature = (id: PlatformFeatureID) => platform.features.some((feature) => feature.id === id);
  // All actions resolve from backend-advertised approved tasks, never from an
  // independent command list that could bypass runtime policy.
  const platformTasks = tasks.filter((task) => task.packId === platform.packId && task.toolId === platform.toolId);
  const taskFor = (commandId: string, risk: Risk) =>
    platformTasks.find((task) => task.commandId === commandId && task.risk === risk);
  const openTask = (key: string, prefill?: Record<string, string>) => {
    if (!ready || workspaceBusy) return;
    const task = platformTasks.find((task) => task.packId + '/' + task.commandId === key);
    if (!task) return;
    const values = Object.fromEntries(task.inputs.filter((input) => input.type !== 'secret' && typeof prefill?.[input.id] === 'string')
      .map((input) => [input.id, prefill![input.id]]));
    const request = { commandId: task.commandId, values, sequence: ++sequence.current };
    setChoice(task.commandId); setTab(tabForCommand(task.commandId));
    if (permissionCommands.includes(task.commandId)) { setPermissionRequest(request); setAction(null); }
    else if (createCommands.includes(task.commandId)) { setCreateRequest(request); setAction(null); }
    else setAction(request);
  };
  const permissionVariable = permissionRequest?.values?.['resource-id'];
  const initialPermissionVariable = permissionVariable?.startsWith((target?.account ?? '') + ':variable:')
    ? permissionVariable.slice(((target?.account ?? '') + ':variable:').length)
    : permissionRequest?.values?.['variable-id']
      ? (permissionRequest.values['policy-branch'] && permissionRequest.values['policy-branch'] !== 'root' ? permissionRequest.values['policy-branch'] + '/' : '') + permissionRequest.values['variable-id']
      : '';
  const selectedAction = action ? platformTasks.find((task) => task.commandId === action.commandId) : undefined;
  const taskAction = (commandId: string, risk: Risk, title: string, detail: string) => {
    const task = taskFor(commandId, risk);
    return <Action title={title} detail={detail} risk={risk} available={ready && !workspaceBusy && task !== undefined}
      onOpen={() => { if (task) openTask(task.packId + '/' + task.commandId); }} />;
  };
  const taskGroup = (ids: string[]) => ids.flatMap((id) => platformTasks.filter((task) => task.commandId === id)).map((task) => (
    <Action key={task.commandId} title={task.name} detail={task.description ?? 'Open the approved CLI workflow.'}
      risk={task.risk} available={ready && !workspaceBusy} onOpen={() => openTask(task.packId + '/' + task.commandId)} />
  ));
  const inspectionTasks = taskGroup(accessInspection);
  const inventoryTasks = taskGroup(resourceInventory);

  const selectByKey = (event: KeyboardEvent) => {
    const index = tabs.findIndex((candidate) => candidate.id === tab);
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    setTab(tabs[next].id);
    document.getElementById('conjur-tab-' + tabs[next].id)?.focus();
  };
  // Panels stay mounted while hidden: leaving a tab must never unmount the
  // two-step create flow between its dependent mutations.
  const panel = (id: TabID) => ({
    role: 'tabpanel', id: 'conjur-panel-' + id, 'aria-labelledby': 'conjur-tab-' + id,
    hidden: tab !== id, className: 'conjur-panel',
  } as const);

  return (
    <div className="conjur-workspace">
      <dl className="conjur-env" aria-label="Conjur environment">
        <div>
          <dt>CLI</dt>
          <dd className={ready ? 'conjur-env-ok' : 'conjur-env-warn'}>
            {tool ? tool.status.charAt(0).toUpperCase() + tool.status.slice(1) : platform.ready ? 'Ready' : 'Not ready'}
            {tool?.version && <span> · {tool.version}</span>}
          </dd>
        </div>
        <div><dt>Conjur server</dt><dd>{target?.applianceUrl ?? 'Not available'}</dd></div>
        <div><dt>Account</dt><dd>{target?.account ?? 'Not available'}</dd></div>
        <div>
          <dt>Session</dt>
          {/* CLI readiness is not authentication; only the vendor session check proves identity. */}
          <dd className="conjur-env-warn">Not verified</dd>
        </div>
        <div className="conjur-env-actions">
          {ready ? (
            hasFeature('sign-in') && <button type="button" className="secondary-button" onClick={() => onOpenFeature('sign-in')}>Check identity</button>
          ) : (
            <button type="button" className="secondary-button" onClick={onOpenDiagnostics}>Open Diagnostics</button>
          )}
        </div>
      </dl>
      {!ready && <p role="status" className="conjur-setup-notice"><strong>Setup needed.</strong> Check tool readiness before using these workflows.</p>}
      <label className="field conjur-action-selector"><span>Conjur action</span>
        <select value={choice} disabled={!ready || !csrfToken || workspaceBusy} onChange={(event) => openTask(platform.packId + '/' + event.target.value)}>
          <option value="">Choose a Conjur action</option>
          {platformTasks.map((task) => <option key={task.commandId} value={task.commandId}>{task.name} · {riskLabel[task.risk]}</option>)}
        </select>
      </label>

      <div className="output-tabs conjur-tabs" role="tablist" aria-label="Conjur workflows" onKeyDown={selectByKey}>
        {tabs.map((candidate) => (
          <button key={candidate.id} type="button" role="tab" id={'conjur-tab-' + candidate.id}
            aria-controls={'conjur-panel-' + candidate.id} aria-selected={tab === candidate.id}
            tabIndex={tab === candidate.id ? 0 : -1} onClick={() => setTab(candidate.id)}>
            {candidate.label}
          </button>
        ))}
      </div>

      <div {...panel('secrets')}>
        <header className="conjur-panel-heading">
          <h3>Secret variables</h3>
          <p>Create, browse, and update variable IDs. Stored values are never displayed.</p>
        </header>
        <div className="conjur-action-list" role="group" aria-label="Conjur secret management">
          {csrfToken ? (
            <ConjurCreateSecret key={discoveryKey + '/' + (target?.account ?? '') + '/' + (target?.applianceUrl ?? '') + '/' + (createRequest?.sequence ?? 0)}
              tasks={platformTasks} csrfToken={csrfToken} account={ready ? target?.account : undefined}
              endpoint={ready ? target?.applianceUrl : undefined} onOpenRuns={onOpenRuns} initial={createRequest?.values} initiallyOpen={createRequest !== null}
              onManageAccess={taskFor('secret-permit', 'change') ? (id) => openTask(platform.packId + '/secret-permit', { 'variable-id': id }) : undefined}
              onInspectTarget={taskFor('resource-exists', 'read') ? (id) => openTask(platform.packId + '/resource-exists', {
                'resource-id': target?.account + ':variable:' + id,
              }) : undefined}
              contextKey={discoveryKey + '/' + (target?.applianceUrl ?? '') + '/' + (target?.account ?? '')} />
          ) : <Action title="Create secret" detail="Requires a verified browser session." available={false} onOpen={() => {}} />}
          {taskAction('list-variables', 'read', 'Browse variables', 'Find visible variable IDs without exposing their stored values.')}
          {taskAction('secret-set-value', 'change', 'Update value', 'Rotate or replace an existing value through secure stdin.')}
        </div>
        <h4 className="conjur-danger-heading">Destructive</h4>
        <div className="conjur-action-list">
          {taskAction('secret-delete', 'destructive', 'Delete variable', 'Permanently remove a variable and its stored versions after typed approval.')}
        </div>
      </div>

      <div {...panel('access')}>
        <header className="conjur-panel-heading">
          <h3>Access &amp; permissions</h3>
          <p>Inspect what Conjur reports first, then grant or revoke with a separate approval. Nothing is swapped automatically.</p>
        </header>
        <div className="conjur-action-list" role="group" aria-label="Conjur permission management">
          <Action title="Inspect access" risk="read" available={ready && hasFeature('access-explorer')}
            detail="Browse resources and roles with bounded, read-only inventory and labeled permission relationships."
            onOpen={() => onOpenFeature('access-explorer')} />
          {csrfToken && (
            <ConjurManagePermissions key={discoveryKey + '/' + (target?.account ?? '') + '/' + (target?.applianceUrl ?? '') + '/' + (permissionRequest?.sequence ?? 0)}
              tasks={platformTasks} csrfToken={csrfToken} account={ready ? target?.account : undefined}
              initiallyOpen={permissionRequest !== null} initialVariable={initialPermissionVariable}
              endpoint={ready ? target?.applianceUrl : undefined}
              contextKey={discoveryKey + '/' + (target?.applianceUrl ?? '') + '/' + (target?.account ?? '')} onOpenRuns={onOpenRuns} />
          )}
          {taskAction('secret-permit', 'change', 'Grant permission', 'Allow a host, group, layer, or user to read, execute, or update a secret variable.')}
          {taskAction('secret-deny', 'change', 'Revoke permission', 'Remove privileges granted by the same policy branch. Verify the original granting branch first.')}
        </div>
        {inspectionTasks.length > 0 && <>
          <h4>Inspection queries</h4>
          <div className="conjur-action-list" role="group" aria-label="Access inspection">{inspectionTasks}</div>
        </>}
      </div>

      <div {...panel('audit')}>
        <header className="conjur-panel-heading">
          <h3>Audit</h3>
          <p>Review secrets hygiene and what CLIHarbor has already run against this environment.</p>
        </header>
        <div className="conjur-action-list" role="group" aria-label="Conjur audit">
          <Action title="Regex pattern explorer" risk="read" available={hasFeature('security-audit')}
            detail="Match variable IDs and metadata against custom patterns. Secret-value matching is opt-in."
            onOpen={() => onOpenFeature('security-audit')} />
          {onOpenRuns && <Action title="Run history & mutation audit" available
            detail="Every run CLIHarbor started, with approvals and outcomes." onOpen={onOpenRuns} />}
        </div>
      </div>

      <div {...panel('tools')}>
        <header className="conjur-panel-heading">
          <h3>Inventory &amp; migration</h3>
          <p>Inspect Conjur inventory or prepare a migration using approved task forms.</p>
        </header>
        {inventoryTasks.length > 0 && <div className="conjur-action-list" role="group" aria-label="Conjur toolbox">
          {inventoryTasks}
        </div>}
        <details id="conjur-migration" className="conjur-migration-details">
          <summary>Migration playbooks &amp; policy templates</summary>
          <ConjurMigrationWorkbench key={discoveryKey} tasks={platformTasks} packId={platform.packId}
            toolId={platform.toolId} onOpenTask={openTask} />
        </details>
      </div>
      {action && <div hidden={tab !== tabForCommand(action.commandId)}>
        {selectedAction && csrfToken && ready ? <ConjurTaskPanel
          key={discoveryKey + '/' + (target?.account ?? '') + '/' + (target?.applianceUrl ?? '') + '/' + action.sequence}
          task={selectedAction} tasks={platformTasks} csrfToken={csrfToken} account={target?.account} endpoint={target?.applianceUrl}
          prefill={action.values} onOpenRuns={onOpenRuns} /> : <p role="status">This Conjur action is not currently available.</p>}
      </div>}
    </div>
  );
}

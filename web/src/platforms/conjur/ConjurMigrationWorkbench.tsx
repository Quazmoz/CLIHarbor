import { useState } from 'react';
import type { Task, TaskRisk } from '../../api/tasks';

/**
 * Migration preparation is presentation-only. The authoritative task catalog
 * and mutation approval state remain owned by the local runtime.
 */
type TemplateKind = 'variable' | 'grant' | 'variable-grant';
type RoleKind = 'group' | 'host' | 'user' | 'layer';
type Privileges = 'read' | 'execute' | 'read, execute' | 'update' | 'read, execute, update';

export interface MigrationDraft {
  kind: TemplateKind;
  branch: string;
  variableId: string;
  roleKind: RoleKind;
  roleId: string;
  privileges: Privileges;
}

// Do not interpolate untrusted identifiers as YAML syntax. A conservative
// single-line subset prevents ambiguous policy branches and review drift.
function validID(value: string, maxLength: number): boolean {
  return value.length > 0 && value.length <= maxLength &&
    /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(value) &&
    !value.split('/').some((part) => part === '.' || part === '..');
}

export function generateConjurPolicyDraft(draft: MigrationDraft): string | null {
  if (!validID(draft.branch, 512) || !validID(draft.variableId, 2048)) return null;
  if (!['variable', 'grant', 'variable-grant'].includes(draft.kind)) return null;

  const lines: string[] = [];
  if (draft.kind !== 'grant') {
    lines.push('- !variable', '  id: ' + JSON.stringify(draft.variableId));
  }
  if (draft.kind !== 'variable') {
    if (!validID(draft.roleId, 2048) ||
        !['group', 'host', 'user', 'layer'].includes(draft.roleKind) ||
        !['read', 'execute', 'read, execute', 'update', 'read, execute, update'].includes(draft.privileges)) {
      return null;
    }
    lines.push('- !permit',
      '  role: !' + draft.roleKind + ' ' + JSON.stringify(draft.roleId),
      '  privileges: [ ' + draft.privileges + ' ]',
      '  resource: !variable ' + JSON.stringify(draft.variableId));
  }
  return lines.join('\n') + '\n';
}

interface TaskShortcut {
  id: string;
  label: string;
  risk: TaskRisk;
  prefill?: Record<string, string>;
}

const playbooks: Array<{ name: string; description: string; actions: TaskShortcut[] }> = [
  {
    name: '1 · Inventory the source',
    description: 'Capture bounded metadata pages and policy IDs. This does not export secret values or guarantee a complete inventory.',
    actions: [
      { id: 'whoami', label: 'Verify identity', risk: 'read' },
      { id: 'list-variables', label: 'Variable IDs', risk: 'read' },
      { id: 'list-policies', label: 'Policy inventory', risk: 'read' },
      { id: 'count-resources', label: 'Resource counts', risk: 'read' },
    ],
  },
  {
    name: '2 · Compare identities and permissions',
    description: 'Inspect identities, memberships, LDAP mappings and effective grants before drafting changes.',
    actions: [
      { id: 'list-hosts', label: 'Host identities', risk: 'read' },
      { id: 'list-groups', label: 'Groups', risk: 'read' },
      { id: 'role-members', label: 'Role members', risk: 'read' },
      { id: 'resource-permitted-roles', label: 'Permissions on a resource', risk: 'read', prefill: { privilege: 'execute' } },
      { id: 'ldap-group-list', label: 'LDAP group mappings', risk: 'read' },
      { id: 'ldap-user-list', label: 'LDAP user mappings', risk: 'read' },
    ],
  },
  {
    name: '3 · Prepare and reconcile the destination',
    description: 'Open only installed, backend-approved tasks. Changes still require target verification and explicit approval.',
    actions: [
      { id: 'resource-exists', label: 'Check destination resource', risk: 'read' },
      { id: 'role-exists', label: 'Check destination role', risk: 'read' },
      { id: 'secret-create', label: 'Create variable declaration', risk: 'change' },
      { id: 'secret-permit', label: 'Grant reviewed access', risk: 'change' },
      { id: 'secret-set-value', label: 'Set value separately', risk: 'change' },
    ],
  },
  {
    name: '4 · Verify cutover',
    description: 'Re-check access in the destination. No automatic deletes, secret transfers or cross-environment writes.',
    actions: [
      { id: 'list-variables', label: 'Verify variable inventory', risk: 'read' },
      { id: 'resource-permitted-roles', label: 'Verify destination access', risk: 'read', prefill: { privilege: 'execute' } },
      { id: 'role-memberships', label: 'Verify inherited roles', risk: 'read' },
    ],
  },
];

interface Props {
  tasks: Task[];
  packId: string;
  toolId: string;
  onOpenTask: (taskKey: string, prefill?: Record<string, string>) => void;
}

export function ConjurMigrationWorkbench({ tasks, packId, toolId, onOpenTask }: Props) {
  const [draft, setDraft] = useState<MigrationDraft>({
    kind: 'variable-grant', branch: 'root', variableId: '',
    roleKind: 'group', roleId: '', privileges: 'read, execute',
  });
  const [copyStatus, setCopyStatus] = useState('');
  const yaml = generateConjurPolicyDraft(draft);
  const availableTasks = tasks.filter((task) => task.packId === packId && task.toolId === toolId);
  const findTask = (id: string, risk: TaskRisk) =>
    availableTasks.find((task) => task.commandId === id && task.risk === risk);

  const openApproved = (action: TaskShortcut, prefill?: Record<string, string>) => {
    const task = findTask(action.id, action.risk);
    if (task === undefined) return;
    onOpenTask(task.packId + '/' + task.commandId, prefill ?? action.prefill);
  };

  const update = <K extends keyof MigrationDraft>(key: K, value: MigrationDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setCopyStatus('');
  };

  return (
    <section className="conjur-migration" aria-label="Conjur migration planning">
      <div className="route-heading">
        <p className="status-label">Migration planning</p>
        <h3>Migration playbooks and policy templates</h3>
        <p>Plan an inventory, compare access and prepare scoped policy changes without exporting secret values.
          Run each step manually against the intended source or destination CLI context.</p>
      </div>
      <div className="platform-toolbox-grid">
        {playbooks.map((playbook) => (
          <section key={playbook.name} className="platform-toolbox-section conjur-migration-stage" aria-label={playbook.name}>
            <h4>{playbook.name}</h4>
            <p>{playbook.description}</p>
            <div className="conjur-migration-actions">
              {playbook.actions.map((action) => {
                const available = findTask(action.id, action.risk) !== undefined;
                return (
                  <button key={action.id} className="secondary-button" type="button"
                    disabled={!available}
                    onClick={() => openApproved(action)}>
                    {action.label}{!available ? ' · unavailable' : action.risk === 'read' ? '' : ' · approval required'}
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>
      <section className="platform-toolbox-section conjur-migration-template" aria-label="Policy template builder">
        <h4>Draft a reviewed policy fragment</h4>
        <p>Only reviewed <code>!variable</code> and <code>!permit</code> shapes are offered.
          This preview is not submitted, checked against a Conjur server, or automatically run.
          Never enter secret values. Resource IDs are relative to the selected policy branch.</p>
        <div className="conjur-migration-form">
          <label>Template
            <select value={draft.kind} onChange={(e) => update('kind', e.target.value as TemplateKind)}>
              <option value="variable">Variable declaration</option>
              <option value="grant">Grant access to existing variable</option>
              <option value="variable-grant">Variable declaration and grant</option>
            </select>
          </label>
          <label>Policy branch
            <input value={draft.branch} maxLength={512} autoComplete="off"
              onChange={(e) => update('branch', e.target.value)} />
          </label>
          <label>Variable ID (relative to branch)
            <input value={draft.variableId} maxLength={2048} autoComplete="off"
              onChange={(e) => update('variableId', e.target.value)} />
          </label>
          {draft.kind !== 'variable' && (
            <>
              <label>Role kind
                <select value={draft.roleKind} onChange={(e) => update('roleKind', e.target.value as RoleKind)}>
                  <option value="group">Group</option>
                  <option value="host">Host</option>
                  <option value="layer">Layer</option>
                  <option value="user">User</option>
                </select>
              </label>
              <label>Role ID (relative to branch; / for absolute)
                <input value={draft.roleId} maxLength={2048} autoComplete="off"
                  onChange={(e) => update('roleId', e.target.value)} />
              </label>
              <label>Privileges
                <select value={draft.privileges} onChange={(e) => update('privileges', e.target.value as Privileges)}>
                  <option value="read, execute">Read and execute</option>
                  <option value="read">Read metadata</option>
                  <option value="execute">Execute</option>
                  <option value="update">Update</option>
                  <option value="read, execute, update">Read, execute and update</option>
                </select>
              </label>
            </>
          )}
        </div>
        <p>Policy update branch: <code>{validID(draft.branch, 512) ? draft.branch : 'Invalid branch'}</code>.
          On SaaS, the vendor dry-run option may be unavailable; never treat a local draft as server validation.</p>
        {yaml === null ? (
          <p role="alert">Enter valid single-line identifiers (letters, digits, _, -, ., /, :) with no empty or dot-only path components. No draft can be generated yet.</p>
        ) : (
          <>
            <label className="conjur-migration-preview">Review-only policy YAML
              <textarea readOnly rows={Math.max(5, yaml.split('\n').length + 1)} value={yaml} />
            </label>
            <div className="conjur-migration-actions">
              <button type="button" className="secondary-button" onClick={() => {
                void navigator.clipboard.writeText(yaml).then(
                  () => setCopyStatus('Copied non-secret policy draft.'),
                  () => setCopyStatus('Clipboard unavailable; select and copy the reviewed text above.'),
                );
              }}>Copy policy draft</button>
              {(draft.kind === 'variable' || draft.kind === 'variable-grant') && (
                <button type="button" disabled={!findTask('secret-create', 'change')} onClick={() => openApproved(
                  { id: 'secret-create', label: '', risk: 'change' },
                  { 'policy-branch': draft.branch, 'variable-id': draft.variableId },
                )}>Review variable creation · approval required</button>
              )}
              {(draft.kind === 'grant' || draft.kind === 'variable-grant') && (
                <button type="button" disabled={!findTask('secret-permit', 'change')} onClick={() => openApproved(
                  { id: 'secret-permit', label: '', risk: 'change' },
                  { 'policy-branch': draft.branch, 'variable-id': draft.variableId,
                    'role-kind': draft.roleKind, 'role-id': draft.roleId, privileges: draft.privileges },
                )}>Review access grant · approval required</button>
              )}
            </div>
            {copyStatus && <p role="status">{copyStatus}</p>}
          </>
        )}
        <p>Migration is not a secret-value export/import. Use the approved, separately authorized Set secret value
          task after verifying the target Conjur environment. Review downstream clients and roll-back procedures before cutover.</p>
      </section>
    </section>
  );
}

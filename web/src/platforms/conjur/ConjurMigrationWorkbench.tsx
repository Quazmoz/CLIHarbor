import { useRef, useState } from 'react';
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
function validID(value: string, maxLength: number, absolute = false): boolean {
  return value.length > 0 && value.length <= maxLength &&
    (absolute ? /^\/?[A-Za-z0-9][A-Za-z0-9_.:/-]*$/ : /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/).test(value) &&
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
    if (!validID(draft.roleId, 2048, true) ||
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

type TemplateCategory = 'all' | 'variables' | 'access' | 'identity';

interface PolicyStarter {
  id: string;
  category: 'variables' | 'access';
  title: string;
  description: string;
  kind: TemplateKind;
  roleKind: RoleKind;
  privileges: Privileges;
}

interface MappingStarter {
  id: string;
  category: 'identity';
  title: string;
  description: string;
  taskId: 'ldap-group-create' | 'ldap-user-create';
}

type GalleryStarter = PolicyStarter | MappingStarter;

// These are presentation presets, not new Conjur policy statements or executable
// commands. Identifier fields are intentionally cleared on every selection.
const templateGallery: GalleryStarter[] = [
  {
    id: 'application-onboarding', category: 'variables',
    title: 'Application secret onboarding',
    description: 'Declare one application variable and prepare read/execute access for its consuming group.',
    kind: 'variable-grant', roleKind: 'group', privileges: 'read, execute',
  },
  {
    id: 'database-credential', category: 'variables',
    title: 'Database credential variable',
    description: 'Declare a database credential variable without a value. Set its value separately using the approved task.',
    kind: 'variable', roleKind: 'group', privileges: 'read, execute',
  },
  {
    id: 'service-access', category: 'access',
    title: 'Service identity access',
    description: 'Prepare read/execute permission for one existing host identity on an existing variable.',
    kind: 'grant', roleKind: 'host', privileges: 'read, execute',
  },
  {
    id: 'developer-metadata', category: 'access',
    title: 'Developer metadata access',
    description: 'Prepare read-only metadata access for a group; do not grant secret-value execution.',
    kind: 'grant', roleKind: 'group', privileges: 'read',
  },
  {
    id: 'environment-layer', category: 'variables',
    title: 'Environment-scoped application',
    description: 'Declare a variable and prepare access for a layer, using a branch explicitly chosen for this environment.',
    kind: 'variable-grant', roleKind: 'layer', privileges: 'read, execute',
  },
  {
    id: 'rotation-operator', category: 'access',
    title: 'Credential rotation operator',
    description: 'Prepare update privilege for a group. This is high-impact access; review scope and account carefully.',
    kind: 'grant', roleKind: 'group', privileges: 'update',
  },
  {
    id: 'ldap-group', category: 'identity',
    title: 'LDAP group mapping',
    description: 'Open the approved Conjur group-to-role mapping form. No policy YAML is generated.',
    taskId: 'ldap-group-create',
  },
  {
    id: 'ldap-user', category: 'identity',
    title: 'LDAP user mapping',
    description: 'Open the approved LDAP user-to-role mapping form. No policy YAML is generated.',
    taskId: 'ldap-user-create',
  },
];

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
      { id: 'list-resources', label: 'Filtered variable inventory', risk: 'read', prefill: { kind: 'variable', limit: '25' } },
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
  const policyHeadingRef = useRef<HTMLHeadingElement>(null);
  const [templateCategory, setTemplateCategory] = useState<TemplateCategory>('all');
  const [selectedTemplateID, setSelectedTemplateID] = useState<string | null>(null);
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
    setSelectedTemplateID(null);
    setCopyStatus('');
  };

  const usePolicyTemplate = (template: PolicyStarter) => {
    setDraft({
      kind: template.kind,
      branch: '',
      variableId: '',
      roleKind: template.roleKind,
      roleId: '',
      privileges: template.privileges,
    });
    setCopyStatus('');
    setSelectedTemplateID(template.id);
    policyHeadingRef.current?.focus();
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
      <section className="platform-toolbox-section conjur-template-gallery" aria-label="Conjur template gallery">
        <h4>Template gallery</h4>
        <p>Choose a reviewed starter. Policy templates use only the existing variable and permission shapes;
          LDAP starters open an approved task form. Selection clears previous policy identifiers, not vendor state.
          None of these templates runs a command or transfers secret values.</p>
        <label className="conjur-template-category">Browse templates
          <select value={templateCategory} onChange={(event) =>
            setTemplateCategory(event.target.value as TemplateCategory)}>
            <option value="all">All templates</option>
            <option value="variables">Variables and applications</option>
            <option value="access">Access permissions</option>
            <option value="identity">LDAP mappings</option>
          </select>
        </label>
        <div className="conjur-template-grid">
          {templateGallery.filter((template) => templateCategory === 'all' ||
            template.category === templateCategory).map((template) => {
            const mapping = 'taskId' in template;
            const available = !mapping || findTask(template.taskId, 'change') !== undefined;
            return (
              <article key={template.id}
                className={'conjur-template-card' +
                  (selectedTemplateID === template.id ? ' conjur-template-card--selected' : '')}>
                <h5>{template.title}</h5>
                <p>{template.description}</p>
                <small>{mapping ? 'Approved mapping form · change approval' : 'Non-secret policy starter · review required'}</small>
                <button type="button" className="secondary-button"
                  disabled={!available}
                  aria-pressed={!mapping && selectedTemplateID === template.id}
                  onClick={() => {
                    if (mapping) {
                      openApproved({ id: template.taskId, label: template.title, risk: 'change' });
                    } else {
                      usePolicyTemplate(template);
                    }
                  }}>
                  {mapping ? available ? 'Open ' + template.title : 'Unavailable in task catalog' :
                    'Use ' + template.title}
                </button>
              </article>
            );
          })}
        </div>
        {selectedTemplateID !== null &&
          <p role="status">Template loaded. Enter the policy branch and identifiers below; nothing has been submitted.</p>}
      </section>
      <section className="platform-toolbox-section conjur-migration-template" aria-label="Policy template builder">
        <h4 ref={policyHeadingRef} tabIndex={-1}>Draft a reviewed policy fragment</h4>
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
                if (!navigator.clipboard?.writeText) {
                  setCopyStatus('Clipboard unavailable; select and copy the reviewed text above.');
                  return;
                }
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

import { useEffect, useMemo, useState } from 'react';
import type { Platform, PlatformFeatureID } from '../../api/platforms';
import type { Task } from '../../api/tasks';
import type { ToolDiagnostic } from '../../api/tools';
import { fetchTerraformProjects, fetchTerraformResources, type TerraformProject, type TerraformResource } from './api';

type Tab = 'overview' | 'projects' | 'resources' | 'state' | 'configuration' | 'plans' | 'history';
const tabs: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' }, { id: 'projects', label: 'Projects' },
  { id: 'resources', label: 'Resources' }, { id: 'state', label: 'State management' },
  { id: 'configuration', label: 'Configuration' }, { id: 'plans', label: 'Plans' },
  { id: 'history', label: 'History' },
];

interface Props {
  platform: Platform;
  tasks: Task[];
  tool?: ToolDiagnostic;
  csrfToken?: string;
  onOpenRuns?: () => void;
  onOpenFeature: (feature: PlatformFeatureID) => void;
  onOpenDiagnostics: () => void;
  onOpenTask: (taskKey: string, prefill?: Record<string, string>) => void;
}

function failureMessage(error: unknown): string {
  return error instanceof Error && error.name !== 'AbortError'
    ? 'Local state inventory could not be loaded. Check the approved project and file permissions.'
    : '';
}

export function TerraformWorkspace({ platform, tasks, tool, onOpenRuns, onOpenDiagnostics, onOpenTask }: Props) {
  const [tab, setTab] = useState<Tab>('overview');
  const [projects, setProjects] = useState<TerraformProject[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [projectError, setProjectError] = useState('');
  const [projectID, setProjectID] = useState('');
  const [stateID, setStateID] = useState('');
  const [loaded, setLoaded] = useState<{ key: string; resources: TerraformResource[] } | null>(null);
  const [loadingResources, setLoadingResources] = useState(false);
  const [resourceError, setResourceError] = useState('');
  const [category, setCategory] = useState('all');
  const [type, setType] = useState('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState('');
  const [outputView, setOutputView] = useState<'table' | 'summary' | 'json'>('table');

  useEffect(() => {
    const controller = new AbortController();
    void fetchTerraformProjects(controller.signal).then((value) => {
      if (!controller.signal.aborted) { setProjects(value); setProjectError(''); }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setProjectError(failureMessage(error));
    }).finally(() => { if (!controller.signal.aborted) setLoadingProjects(false); });
    return () => controller.abort();
  }, []);

  const project = projects.find((item) => item.id === projectID);
  const state = project?.states.find((item) => item.id === stateID);
  const selectionKey = project && state ? project.id + '/' + state.id : '';
  useEffect(() => {
    if (!selectionKey) return;
    const controller = new AbortController();
    // A state inventory belongs only to the exact currently selected pair.
    // Older responses are aborted and never rendered under a new selection.
    void fetchTerraformResources(projectID, stateID, controller.signal).then((resources) => {
      if (!controller.signal.aborted) { setLoaded({ key: selectionKey, resources }); setResourceError(''); }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setResourceError(failureMessage(error));
    }).finally(() => { if (!controller.signal.aborted) setLoadingResources(false); });
    return () => controller.abort();
  }, [projectID, stateID, selectionKey]);
  const resources = loaded?.key === selectionKey ? loaded.resources : [];
  const categoryResources = category === 'all' ? resources : resources.filter((r) => r.category === category);
  const types = useMemo(() => [...new Set(categoryResources.map((r) => r.type))].sort(), [categoryResources]);
  const filtered = categoryResources.filter((r) => (type === 'all' || r.type === type) &&
    (query.trim() === '' || r.address.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
  const selectedResource = resources.find((r) => r.address === selected);
  const ready = platform.ready && tool?.status === 'ready';
  const taskFor = (id: string) => tasks.find((t) =>
    t.packId === platform.packId && t.toolId === platform.toolId && t.commandId === id && t.risk === 'read');
  const openHelp = (id: string) => {
    const task = taskFor(id);
    if (ready && task) onOpenTask(task.packId + '/' + task.commandId);
  };

  return (
    <div className="terraform-workspace">
      <div className="terraform-context" role="status">
        <span><strong>CLI</strong> {tool?.status ?? 'Unavailable'}{tool?.version ? ' · ' + tool.version : ''}</span>
        <span><strong>Projects</strong> {projects.length} approved</span>
        <span><strong>Mode</strong> Read-only local state</span>
        {!ready && <button type="button" className="secondary-button" onClick={onOpenDiagnostics}>Check Terraform discovery</button>}
      </div>
      <nav className="terraform-navigation" aria-label="Terraform workspace">
        {tabs.map(({ id, label }) => (
          <button key={id} type="button" className={tab === id ? 'terraform-current' : 'secondary-button'}
            aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>{label}</button>
        ))}
      </nav>
      {(tab === 'overview' || tab === 'projects' || tab === 'resources' || tab === 'state') && (
        <section aria-labelledby="terraform-project-heading" className="terraform-section">
          <h3 id="terraform-project-heading">Local state inventory</h3>
          <p>Only folders approved when CLIHarbor starts are listed. State attributes, outputs and provider credentials are never displayed.</p>
          <div className="terraform-controls">
            <label>Approved project
              <select value={project ? projectID : ''} disabled={loadingProjects || !!projectError}
                onChange={(e) => { setProjectID(e.target.value); setStateID(''); setSelected(''); setLoaded(null); setResourceError(''); setCategory('all'); setType('all'); setQuery(''); }}>
                <option value="">Select a project</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.id})</option>)}
              </select>
            </label>
            <label>Local state file
              <select value={state ? stateID : ''} disabled={!project}
                onChange={(e) => { setStateID(e.target.value); setSelected(''); setLoaded(null); setResourceError(''); setCategory('all'); setType('all'); setQuery(''); setLoadingResources(e.target.value !== ''); }}>
                <option value="">Select local state</option>
                {project?.states.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
          </div>
          {loadingProjects && <p role="status">Loading approved projects…</p>}
          {projectError && <p role="alert">{projectError}</p>}
          {!loadingProjects && !projectError && projects.length === 0 &&
            <p role="status">No approved projects. Restart CLIHarbor with <code>--terraform-project</code> pointing to a trusted, existing local Terraform folder.</p>}
          {project && project.states.length === 0 && <p role="status">No direct-child local .tfstate files are available in this approved folder.</p>}
          {state && loadingResources && <p role="status">Reading local resource addresses…</p>}
          {state && resourceError && <p role="alert">{resourceError}</p>}
          {state && !loadingResources && !resourceError && loaded?.key === selectionKey && (
            <p role="status">{resources.length} address{resources.length === 1 ? '' : 'es'} in the selected state snapshot. Read-only; Terraform CLI execution is not invoked.</p>
          )}
        </section>
      )}
      {(tab === 'overview' || tab === 'resources' || tab === 'state') && state && loaded?.key === selectionKey && !resourceError && !loadingResources && (
        <section className="terraform-section" aria-labelledby="terraform-resources-heading">
          <h3 id="terraform-resources-heading">Resources</h3>
          <div className="terraform-controls">
            <label>Resource category
              <select value={category} onChange={(e) => { setCategory(e.target.value); setType('all'); setSelected(''); }}>
                <option value="all">All resources</option><option value="managed">Managed</option><option value="data">Data sources</option>
              </select>
            </label>
            <label>Resource type
              <select value={types.includes(type) ? type : 'all'} onChange={(e) => { setType(e.target.value); setSelected(''); }}>
                <option value="all">All types</option>{types.map((t) => <option value={t} key={t}>{t}</option>)}
              </select>
            </label>
            <label>Search addresses
              <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter exact resource addresses" />
            </label>
            <label>Output view
              <select value={outputView} onChange={(e) => setOutputView(e.target.value as 'table' | 'summary' | 'json')}>
                <option value="table">Table</option><option value="summary">Safe summary</option><option value="json">JSON addresses</option>
              </select>
            </label>
          </div>
          {outputView === 'summary' ? (
            <p role="status">{filtered.length} matching addresses across {new Set(filtered.map((r) => r.type)).size} types. No Terraform attributes were read into the response.</p>
          ) : outputView === 'json' ? (
            <pre className="terraform-json">{JSON.stringify(filtered.map(({ address, type, category, module }) => ({ address, type, category, module })), null, 2)}</pre>
          ) : (
            <div className="terraform-table-wrap">
              <table className="terraform-table">
                <thead><tr><th scope="col">Category</th><th scope="col">Type</th><th scope="col">Module</th><th scope="col">Exact address</th><th scope="col">Select</th></tr></thead>
                <tbody>{filtered.map((r) => <tr key={r.address}>
                  <td>{r.category}</td><td>{r.type}</td><td>{r.module || 'Root'}</td>
                  <td><code>{r.address}</code></td>
                  <td><button type="button" className="secondary-button" aria-pressed={selected === r.address}
                    onClick={() => setSelected(r.address)}>{selected === r.address ? 'Selected' : 'Select'}</button></td>
                </tr>)}</tbody>
              </table>
              {filtered.length === 0 && <p role="status">No matching resource addresses.</p>}
            </div>
          )}
          <label>Selected resource
            <select value={selectedResource ? selected : ''} onChange={(e) => setSelected(e.target.value)}>
              <option value="">Select exact resource</option>
              {filtered.map((r) => <option key={r.address} value={r.address}>{r.address}</option>)}
            </select>
          </label>
          {selectedResource && <p><strong>Exact address:</strong> <code>{selectedResource.address}</code></p>}

        </section>
      )}
      {tab === 'state' && <section className="terraform-section terraform-safety" aria-labelledby="terraform-state-safety">
        <h3 id="terraform-state-safety">State detachment — unavailable</h3>
        <p><code>terraform state rm</code> forgets bindings, not cloud resources. A later apply can recreate objects. A server-enforced dry run, snapshot identity, exclusive locking, verified backups and one-use approvals are required before enabling removal.</p>
        <button type="button" disabled>Preview removal (not yet qualified)</button>
      </section>}
      {(tab === 'configuration' || tab === 'plans' || tab === 'history') && (
        <section className="terraform-section" role="status">
          <h3>{tabs.find((t) => t.id === tab)?.label}</h3>
          <p>{tab === 'configuration'
            ? 'Configuration checks are not enabled; formatting or validation can expose source excerpts and require provider initialization.'
            : tab === 'plans'
              ? 'Plan execution is disabled. Refresh, provider access and secret-bearing plan output have not been qualified.'
              : 'Run history for approved Terraform state changes will appear when safe state mutations are enabled. None can execute in this version.'}</p>
        </section>
      )}
      {(tab === 'overview' || tab === 'configuration') && (
        <section className="terraform-section" aria-labelledby="terraform-help-heading">
          <h3 id="terraform-help-heading">Installed CLI reference</h3>
          <div className="terraform-help">
            {(['version', 'workflow-reference', 'command-reference'] as const).map((id) => (
              <button key={id} type="button" className="secondary-button" disabled={!ready || !taskFor(id)} onClick={() => openHelp(id)}>
                {id === 'version' ? 'Version' : id === 'workflow-reference' ? 'Workflow help' : 'Command help'}
              </button>
            ))}
            {onOpenRuns && <button type="button" className="secondary-button" onClick={onOpenRuns}>CLIHarbor run history</button>}
          </div>
        </section>
      )}
    </div>
  );
}

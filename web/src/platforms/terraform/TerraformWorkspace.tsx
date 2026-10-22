import { useEffect, useMemo, useState } from 'react';
import type { Platform, PlatformFeatureID } from '../../api/platforms';
import type { Task } from '../../api/tasks';
import type { ToolDiagnostic } from '../../api/tools';
import { fetchTerraformProjects, fetchTerraformResources, fetchTerraformFormatCheck, type TerraformFormatReport, type TerraformProject, type TerraformResource } from './api';

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

export function TerraformWorkspace({ platform, tasks, tool, csrfToken, onOpenRuns, onOpenDiagnostics, onOpenTask }: Props) {
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
  const [formatRequest, setFormatRequest] = useState<{ projectId: string; number: number } | null>(null);
  const [formatReport, setFormatReport] = useState<TerraformFormatReport | null>(null);
  const [checkingFormat, setCheckingFormat] = useState(false);
  const [formatError, setFormatError] = useState('');
  const [formatFilter, setFormatFilter] = useState<'all' | 'formatted' | 'needs-formatting' | 'failed'>('all');

  useEffect(() => {
    const controller = new AbortController();
    void fetchTerraformProjects(controller.signal).then((value) => {
      if (!controller.signal.aborted) { setProjects(value); setProjectError(''); }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setProjectError(failureMessage(error));
    }).finally(() => { if (!controller.signal.aborted) setLoadingProjects(false); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!formatRequest || formatRequest.projectId !== projectID || !csrfToken) return;
    const controller = new AbortController();
    void fetchTerraformFormatCheck(formatRequest.projectId, csrfToken, controller.signal).then((report) => {
      if (!controller.signal.aborted) { setFormatReport(report); setFormatError(''); }
    }).catch((_error: unknown) => {
      if (!controller.signal.aborted) {
        setFormatReport(null);
        setFormatError('Formatting check failed. Verify Terraform readiness, project permissions and configuration limits.');
      }
    }).finally(() => { if (!controller.signal.aborted) setCheckingFormat(false); });
    return () => controller.abort();
  }, [formatRequest, projectID, csrfToken]);
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
  const currentFormat = formatReport?.projectId === projectID ? formatReport : null;
  const formatFiles = currentFormat?.files ?? [];
  const visibleFormatFiles = formatFiles.filter((file) => formatFilter === 'all' ||
    (formatFilter === 'failed' ? file.status === 'inspection-failed' || file.status === 'unsupported' : file.status === formatFilter));
  const passing = formatFiles.filter((file) => file.status === 'formatted').length;
  const noncompliant = formatFiles.filter((file) => file.status === 'needs-formatting').length;
  const failed = formatFiles.length - passing - noncompliant;
  const approvedConfigFiles = projects.reduce((sum, item) => sum + item.configurationFiles, 0);
  const managedCount = resources.filter((resource) => resource.category === 'managed').length;
  const dataCount = resources.length - managedCount;
  const startFormatCheck = () => {
    if (!project || !ready || !csrfToken || checkingFormat || project.configurationFiles > 64) return;
    setFormatReport(null);
    setFormatError('');
    setFormatFilter('all');
    setCheckingFormat(true);
    setFormatRequest((previous) => ({ projectId: project.id, number: (previous?.number ?? 0) + 1 }));
  };
  const taskFor = (id: string) => tasks.find((t) =>
    t.packId === platform.packId && t.toolId === platform.toolId && t.commandId === id && t.risk === 'read');
  const openHelp = (id: string) => {
    const task = taskFor(id);
    if (ready && task) onOpenTask(task.packId + '/' + task.commandId);
  };

  return (
    <div className="terraform-workspace">
      <div className="terraform-context">
        <span><strong>CLI</strong> {tool?.status ?? 'Unavailable'}{tool?.version ? ' · ' + tool.version : ''}</span>
        <span><strong>Projects</strong> {projects.length} approved</span>
        <span><strong>Mode</strong> Read-only configuration + local state</span>
        {!ready && <>
          <button type="button" className="secondary-button" onClick={onOpenDiagnostics}>Check Terraform discovery</button>
          {tool?.status === 'missing' && <a className="secondary-button terraform-download-link" href="https://developer.hashicorp.com/terraform/install"
            target="_blank" rel="noopener noreferrer">Get Terraform (official)</a>}
        </>}
      </div>
      <nav className="terraform-navigation" aria-label="Terraform workspace">
        {tabs.map(({ id, label }) => (
          <button key={id} type="button" className={tab === id ? 'terraform-current' : 'secondary-button'}
            aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>{label}</button>
        ))}
      </nav>
      {tab === 'overview' && <section className="terraform-section" aria-labelledby="terraform-health-heading">
        <h3 id="terraform-health-heading">Configuration & state health</h3>
        <div className="terraform-health">
          <div><strong>Terraform CLI</strong><span>{ready ? 'Ready · ' + (tool?.version ?? 'Version unavailable') : 'Unavailable'}</span></div>
          <div><strong>Approved projects</strong><span>{loadingProjects || projectError ? 'Unavailable' : projects.length}</span></div>
          <div><strong>Eligible .tf files</strong><span>{loadingProjects || projectError ? 'Unavailable' : approvedConfigFiles}</span></div>
          <div><strong>Formatting</strong><span>{currentFormat ? passing + ' passing · ' + noncompliant + ' need formatting · ' + failed + ' failed' : 'Not checked'}</span></div>
          <div><strong>Selected state inventory</strong><span>{loaded?.key === selectionKey && !resourceError && !loadingResources ? managedCount + ' managed · ' + dataCount + ' data' : 'Not inspected'}</span></div>
          <div><strong>Last completed check</strong><span>{currentFormat ? new Date(currentFormat.checkedAt).toLocaleString() : 'None for selected project'}</span></div>
        </div>
        <p>Formatting measures source layout, not configuration validity, infrastructure drift, a plan, or remote resource health.</p>
      </section>}
      {(tab === 'overview' || tab === 'projects' || tab === 'resources' || tab === 'state' || tab === 'configuration') && (
        <section aria-labelledby="terraform-project-heading" className="terraform-section">
          <h3 id="terraform-project-heading">Approved project and local state</h3>
          <p>Only folders approved when CLIHarbor starts are listed. Configuration source, state attributes, outputs and provider credentials are never displayed.</p>
          <div className="terraform-controls">
            <label>Approved project
              <select value={project ? projectID : ''} disabled={loadingProjects || !!projectError}
                onChange={(e) => { setProjectID(e.target.value); setStateID(''); setSelected(''); setLoaded(null); setResourceError(''); setCategory('all'); setType('all'); setQuery(''); setFormatRequest(null); setFormatReport(null); setFormatError(''); setCheckingFormat(false); }}>
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
                    aria-label={(selected === r.address ? 'Selected ' : 'Select ') + r.address}
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
      {tab === 'configuration' && (
        <section className="terraform-section" aria-labelledby="terraform-format-heading">
          <h3 id="terraform-format-heading">Configuration formatting</h3>
          <p>Check direct-child .tf files in the selected approved project. Files are read into bounded memory and sent over stdin to the verified local Terraform CLI, never modified or uploaded. No source excerpts or diffs are displayed.</p>
          <div className="terraform-format-actions">
            <button type="button" onClick={startFormatCheck} disabled={!project || !ready || !csrfToken || checkingFormat || loadingProjects || project.configurationFiles > 64}>
              {checkingFormat ? 'Checking formatting…' : 'Check formatting'}
            </button>
            <span>{project
              ? project.configurationFiles > 64
                ? project.configurationFiles + ' eligible files · check limit 64 files'
                : project.configurationFiles + ' eligible files'
              : 'Select an approved project'}</span>
          </div>
          {project && project.configurationFiles > 64 && <p role="alert">Formatting is unavailable for projects with more than 64 eligible .tf files. State inspection remains available.</p>}
          {!ready && <p role="status">Terraform CLI must be ready before checking formatting.</p>}
          {ready && !csrfToken && <p role="alert">The browser session must be refreshed before formatting checks are available.</p>}
          {checkingFormat && <p role="status">Checking formatting without changing project files…</p>}
          {formatError && <p role="alert">{formatError}</p>}
          {currentFormat && !checkingFormat && (
            <>
              <p role="status">Completed {new Date(currentFormat.checkedAt).toLocaleString()} using Terraform {currentFormat.terraformVersion}: {passing} passing, {noncompliant} need formatting, {failed} failed or unsupported.</p>
              <label>Filter formatting results
                <select value={formatFilter} onChange={(e) => setFormatFilter(e.target.value as typeof formatFilter)}>
                  <option value="all">All results</option>
                  <option value="formatted">Passing</option>
                  <option value="needs-formatting">Needs formatting</option>
                  <option value="failed">Failed or unsupported</option>
                </select>
              </label>
              <div className="terraform-table-wrap">
                <table className="terraform-table">
                  <thead><tr><th scope="col">File</th><th scope="col">Status</th><th scope="col">Explanation</th></tr></thead>
                  <tbody>{visibleFormatFiles.map((file) => <tr key={file.name}>
                    <td><code>{file.name}</code></td>
                    <td>{file.status === 'needs-formatting' ? 'Needs formatting' : file.status === 'inspection-failed' ? 'Inspection failed' : file.status === 'unsupported' ? 'Unsupported' : 'Formatted'}</td>
                    <td>{file.reason ?? (file.status === 'formatted' ? 'Canonical Terraform formatting.' : 'Run terraform fmt manually to review changes.')}</td>
                  </tr>)}</tbody>
                </table>
                {visibleFormatFiles.length === 0 && <p role="status">No files match this filter.</p>}
              </div>
            </>
          )}
          {!checkingFormat && !currentFormat && !formatError && <p role="status">No completed formatting check for this project.</p>}
        </section>
      )}
      {(tab === 'plans' || tab === 'history') && (
        <section className="terraform-section" role="status">
          <h3>{tabs.find((t) => t.id === tab)?.label}</h3>
          <p>{tab === 'plans'
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

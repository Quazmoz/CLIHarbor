import { useState } from 'react';
import type { AppErrorDetail } from './api/errors';
import type { Task } from './api/tasks';
import type { ToolDiagnostic } from './api/tools';
import { describeToolReadiness } from './operatorLanguage';
import { PackAuthoringWizard } from './PackAuthoringWizard';

interface ToolsPageProps {
  tools: ToolDiagnostic[];
  tasks: Task[];
  catalog?: boolean;
  installingKey: string | null;
  notice: { key: string; message: string; failure?: AppErrorDetail } | null;
  installRoots: Record<string, string>;
  tasksLocked: boolean;
  onInstall: (tool: ToolDiagnostic) => void;
  onInstallRoot: (key: string, value: string) => void;
  onOpenTasks: (key: string) => void;
  onOpenAuthentication: (tool: ToolDiagnostic) => void;
}

export function ToolsPage({ tools, tasks, catalog = false, installingKey, notice, installRoots, tasksLocked,
  onInstall, onInstallRoot, onOpenTasks, onOpenAuthentication }: ToolsPageProps) {
  const [query, setQuery] = useState('');
  const search = query.trim().toLocaleLowerCase();
  const visible = tools.filter((tool) => !catalog || `${tool.packName} ${tool.packId} ${tool.toolId}`.toLocaleLowerCase().includes(search));
  return (
    <section className="panel tool-diagnostics" aria-labelledby="tool-diagnostics-heading">
      <div className="tool-diagnostics-heading">
        <div>
          <p className="status-label">{catalog ? 'Supported CLIs' : 'Diagnostics'}</p>
          <h2 id="tool-diagnostics-heading">{catalog ? 'Add a CLI' : 'Tool readiness'}</h2>
        </div>
        <span className="summary-meta">{tools.filter((tool) => tool.status === 'ready').length}/{tools.length} ready</span>
      </div>
      {catalog && (
        <div className="cli-catalog-intro">
          <h3>Install a supported CLI</h3>
          <p>Choose a CLI from the reviewed catalog. CLIHarbor verifies the official download and adds its approved tasks to your workspace.</p>
          <p>Installation is for your user only. Sign-in and service configuration remain separate.</p>
          <label>Find a CLI<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search supported tools" /></label>
          <p role="status">{visible.length} supported {visible.length === 1 ? 'CLI' : 'CLIs'}</p>
        </div>
      )}
      {catalog && <PackAuthoringWizard registeredPackIds={[...new Set(tools.map((tool) => tool.packId))]} />}
      <div className="diagnostics-body" aria-label="Configured CLI tool diagnostics">
        {visible.length === 0 ? (
          <p>{tools.length === 0 ? 'No tools are configured. Load a reviewed pack to add a CLI.' : 'No supported CLIs match your search.'}</p>
        ) : (
          <ul className={'tool-list' + (catalog ? ' cli-catalog-list' : '')}>
            {visible.map((tool) => {
              const key = tool.packId + '/' + tool.toolId;
              const view = describeToolReadiness(tool);
              const taskCount = tasks.filter((task) => task.packId === tool.packId && task.toolId === tool.toolId).length;
              const locationError = notice?.key === key && notice.failure?.field === 'installRoot' ? notice.failure : undefined;
              return (
                <li key={key}>
                  <div className="tool-summary">
                    <strong>{catalog ? tool.packName : view.heading}</strong>
                    <span className={'tool-status ' + (view.ready ? 'tool-status--ready' : 'tool-status--attention')}>{view.statusText}</span>
                  </div>
                  <p>{view.summary}</p>
                  <p className="tool-next-step"><strong>Next:</strong> {view.nextStep}</p>
                  {tool.status === 'ready' && (
                    <div className="tool-install-actions">
                      {taskCount > 0 && <button type="button" disabled={tasksLocked} onClick={() => onOpenTasks(key)}>Open {taskCount} {taskCount === 1 ? 'task' : 'tasks'}</button>}
                      {tool.requiresVendorSession && <button type="button" className="secondary-button" onClick={() => onOpenAuthentication(tool)}>Check {tool.toolId} session</button>}
                    </div>
                  )}
                  {tool.status === 'missing' && tool.install !== undefined && (
                    <div className="tool-install-controls" aria-busy={installingKey === key}>
                      <p>Verified download: v{tool.install.version}</p>
                      {tool.toolId === 'kubectl' && <p>Use a kubectl version within one minor release of your cluster.</p>}
                      {tool.install.customLocation && (
                        <label className="tool-install-location">
                          <span>Install base directory <span className="field-requirement">Optional</span></span>
                          <input type="text" value={installRoots[key] ?? ''} disabled={installingKey !== null}
                            placeholder="Leave blank for CLIHarbor's default user cache" autoComplete="off" spellCheck={false}
                            aria-invalid={locationError ? true : undefined} aria-describedby={locationError ? key + '-install-error' : undefined}
                            onChange={(event) => onInstallRoot(key, event.target.value)} />
                          <small>Custom locations must be absolute paths inside your user home directory.</small>
                          {locationError && <small id={key + '-install-error'}>{locationError.message}</small>}
                        </label>
                      )}
                      <div className="tool-install-actions">
                        <button type="button" disabled={installingKey !== null} onClick={() => onInstall(tool)}>
                          {installingKey === key ? 'Installing and verifying…' : 'Install ' + tool.packName}
                        </button>
                        <span>Verified current-user install · no admin credentials</span>
                      </div>
                    </div>
                  )}
                  {catalog && tool.status === 'missing' && tool.install === undefined && (
                    <p>{tool.toolId === 'docker'
                      ? 'Install Docker through your approved setup, including a working Docker engine, then restart CLIHarbor.'
                      : 'A verified download is not available for this platform. Use your approved installer, then restart CLIHarbor.'}</p>
                  )}
                  {notice?.key === key && (
                    <div className={'tool-install-result' + (notice.failure ? ' tool-install-result--error' : '')} role={notice.failure ? 'alert' : 'status'}>
                      <p>{notice.message}</p>
                      {notice.failure?.remediation && <p>{notice.failure.remediation}</p>}
                    </div>
                  )}
                  <details className="technical-details tool-technical-details">
                    <summary>Technical details</summary>
                    <p>Pack: {tool.packName} ({tool.packId}) · Pack version: {tool.packVersion} · Tool ID: {tool.toolId}</p>
                    <p>Runtime status: {tool.status}{tool.version ? ' · Detected version: ' + tool.version : ''}{tool.versionConstraint ? ' · Required version: ' + tool.versionConstraint : ''}</p>
                    {tool.message && <p>Runtime detail: {tool.message}</p>}
                  </details>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

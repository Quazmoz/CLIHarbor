import { useState } from 'react';
import type { AppErrorDetail } from './api/errors';
import type { Task } from './api/tasks';
import type { ToolDiagnostic } from './api/tools';
import { describeToolReadiness } from './operatorLanguage';
import { PackAuthoringWizard } from './PackAuthoringWizard';
import { ToolIcon } from './ToolIcon';

// CLIHarbor already searches this user-owned Windows directory at startup.
const TERRAFORM_WINDOWS_USER_HOME = '%USERPROFILE%';
const TERRAFORM_WINDOWS_USER_BIN = '%USERPROFILE%\\bin';

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
  onOpenAuthentication: () => void;
}

export function ToolsPage({ tools, tasks, catalog = false, installingKey, notice, installRoots, tasksLocked,
  onInstall, onInstallRoot, onOpenTasks, onOpenAuthentication }: ToolsPageProps) {
  const [query, setQuery] = useState('');
  const [terraformPathCopy, setTerraformPathCopy] = useState<'copied' | 'failed' | null>(null);
  const copyTerraformPath = async () => {
    try {
      await navigator.clipboard.writeText(TERRAFORM_WINDOWS_USER_HOME);
      setTerraformPathCopy('copied');
    } catch {
      setTerraformPathCopy('failed');
    }
  };
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
          <div className="catalog-paths" aria-label="Ways to add a CLI">
            <a href="#supported-cli-list">
              <strong>Install a supported CLI</strong>
              <span>Choose a reviewed tool and install it for your user.</span>
            </a>
            <a href="#pack-authoring-heading">
              <strong>Create a custom CLI pack</strong>
              <span>Not listed? Draft a YAML pack for operator review.</span>
            </a>
          </div>
          <h3>Install a supported CLI</h3>
          <p>Choose a reviewed CLI. Where verified in-app installation is available, CLIHarbor can install it for your user. Other tools have guided manual setup.</p>
          <p>Installation is for your user only. Sign-in and service configuration remain separate.</p>
          <label>Find a CLI<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search supported tools" /></label>
          <p role="status">{visible.length} supported {visible.length === 1 ? 'CLI' : 'CLIs'}</p>
        </div>
      )}
      <div id={catalog ? 'supported-cli-list' : undefined} className="diagnostics-body" aria-label="Configured CLI tool diagnostics">
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
                    <span className="tool-summary-title"><ToolIcon tool={tool} /><strong>{catalog ? tool.packName : view.heading}</strong></span>
                    <span className={'tool-status ' + (view.ready ? 'tool-status--ready' : 'tool-status--attention')}>{view.statusText}</span>
                  </div>
                  <p>{view.summary}</p>
                  <p className="tool-next-step"><strong>Next:</strong> {tool.packId === 'terraform-cli' && tool.status === 'missing' && !tool.install
                    ? 'Follow the no-admin Windows setup below; editing PATH is optional.'
                    : view.nextStep}</p>
                  {tool.status === 'ready' && (
                    <div className="tool-install-actions">
                      {taskCount > 0 && <button type="button" disabled={tasksLocked} onClick={() => onOpenTasks(key)}>Open {taskCount} {taskCount === 1 ? 'task' : 'tasks'}</button>}
                      {tool.requiresVendorSession && <button type="button" className="secondary-button" onClick={onOpenAuthentication}>Sign in to {tool.toolId}</button>}
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
                  {tool.packId === 'terraform-cli' && tool.status === 'missing' && tool.install === undefined && (
                    <div className="tool-install-controls" aria-label="Set up Terraform for your Windows account">
                      <p><strong>Windows: no administrator or PATH changes needed.</strong> CLIHarbor checks your user-owned <code>bin</code> folder automatically when it starts.</p>
                      <ol className="terraform-setup-steps">
                        <li>
                          <a className="secondary-button terraform-download-link" href="https://developer.hashicorp.com/terraform/install"
                            target="_blank" rel="noopener noreferrer">Download Terraform from HashiCorp</a>
                          <span>Get the Windows ZIP for your computer, using an organization-approved version{tool.versionConstraint ? ` (${tool.versionConstraint})` : ''}.</span>
                        </li>
                        <li>
                          <span>Open File Explorer and go to your existing Windows user folder. Create a folder named <code>bin</code> there if needed.</span>
                          <div className="tool-install-actions">
                            <code>{TERRAFORM_WINDOWS_USER_HOME}</code>
                            <button type="button" className="secondary-button" onClick={() => { void copyTerraformPath(); }}>Copy user folder</button>
                          </div>
                          <small role="status" aria-live="polite">{terraformPathCopy === 'copied'
                            ? 'Copied. Paste into the File Explorer address bar, then create the bin folder.'
                            : terraformPathCopy === 'failed'
                              ? 'Clipboard unavailable. You can select and copy the user folder shown above.'
                              : ''}</small>
                        </li>
                        <li>
                          <span>Extract the ZIP and put <code>terraform.exe</code> directly inside <code>bin</code>, not in a nested folder. The finished file location should be:</span>
                          <code>{TERRAFORM_WINDOWS_USER_BIN}\\terraform.exe</code>
                        </li>
                        <li>
                          <span>Close CLIHarbor and launch it again from a new terminal so it can detect and check Terraform. Refreshing this page alone is not enough.</span>
                        </li>
                      </ol>
                      <details className="technical-details">
                        <summary>Already have Terraform elsewhere? Optional PATH setup</summary>
                        <p>If your approved installation is in another folder, you can add the <strong>folder containing terraform.exe</strong> to your <strong>User Path</strong> (not the system Path):</p>
                        <ol className="terraform-setup-steps">
                          <li>Search Windows Start for <strong>Edit environment variables for your account</strong>.</li>
                          <li>Under <strong>User variables</strong>, select <strong>Path → Edit → New</strong>. Enter the folder containing <code>terraform.exe</code>, not the executable itself.</li>
                          <li>Save the dialogs, open a <strong>new</strong> terminal, and relaunch CLIHarbor. Do this only if your organization's policies allow it.</li>
                        </ol>
                        <p>Alternatively, the CLIHarbor operator can start the backend with <code>--tool-path "terraform-cli/terraform=C:\\path\\to\\terraform.exe"</code>. The browser cannot change which executable is trusted.</p>
                        <p>On macOS or Linux, use an approved CLI installation in your existing PATH or user <code>~/bin</code> directory.</p>
                      </details>
                      <small>Manual official download only. In-app automatic Terraform installation is disabled until the executable's hash and size are independently qualified. CLIHarbor still verifies the discovered executable and version before enabling tasks.</small>
                    </div>
                  )}
                  {tool.packId === 'terraform-cli' && tool.status === 'incompatible' && (
                    <div className="tool-install-controls" role="status">
                      <p><strong>Terraform was found, but its version is not supported.</strong> {tool.version ? 'Detected: ' + tool.version + '. ' : ''}Required: {tool.versionConstraint ?? 'a version supported by your reviewed pack'}.</p>
                      <p>CLIHarbor checks existing PATH matches before its user-bin fallback. Placing another copy in <code>{TERRAFORM_WINDOWS_USER_BIN}</code> will not replace an already detected PATH executable. Ask your administrator to update the approved installation or start CLIHarbor with an approved backend <code>--tool-path</code> override.</p>
                    </div>
                  )}
                  {tool.packId === 'terraform-cli' && tool.status === 'invalid-override' && (
                    <p role="status">A configured backend <code>--tool-path</code> override takes precedence over automatic discovery. Correct or remove that override, then relaunch CLIHarbor. The browser cannot change it.</p>
                  )}
                  {catalog && tool.packId !== 'terraform-cli' && tool.status === 'missing' && tool.install === undefined && (
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
      {catalog && <PackAuthoringWizard registeredPackIds={[...new Set(tools.map((tool) => tool.packId))]} />}
    </section>
  );
}

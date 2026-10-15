import { useId, useState, type KeyboardEvent } from 'react';
import type { Platform } from '../../api/platforms';
import type { Task } from '../../api/tasks';
import type { ToolDiagnostic } from '../../api/tools';

interface Props {
  platform: Platform;
  tasks: Task[];
  tool?: ToolDiagnostic;
  onOpenRuns?: () => void;
  onOpenDiagnostics: () => void;
  onOpenTask: (taskKey: string, prefill?: Record<string, string>) => void;
}

const tabs = ['Overview', 'Safes', 'Accounts', 'Connection'] as const;
type Tab = (typeof tabs)[number];

/** Reviewed idsec operations use the existing task planner and run history. */
export function IdiraWorkspace({ platform, tasks, tool, onOpenRuns, onOpenDiagnostics, onOpenTask }: Props) {
  const [tab, setTab] = useState<Tab>('Overview');
  const [search, setSearch] = useState('');
  const [safe, setSafe] = useState('');
  const [offset, setOffset] = useState('0');
  const searchID = useId();
  const safeID = useId();
  const offsetID = useId();
  const ready = platform.ready && tool?.status === 'ready';
  const available = tasks.filter((task) => task.packId === platform.packId && task.toolId === platform.toolId && task.risk === 'read');
  const task = (id: string) => available.find((candidate) => candidate.commandId === id);
  const open = (id: string, values?: Record<string, string>) => {
    const selected = task(id);
    if (ready && selected) onOpenTask(selected.packId + '/' + selected.commandId, values);
  };
  const action = (id: string, label: string, description: string, values?: Record<string, string>) => (
    <button type="button" className="conjur-action" disabled={!ready || !task(id)}
      aria-label={label} onClick={() => open(id, values)}>
      <span className="conjur-action-text">
        <strong>{label}</strong>
        <span>{!ready ? 'CLI is unavailable. Open diagnostics to review setup.' : description}</span>
      </span>
      <span className="task-risk-badge task-risk-badge--read">Read-only</span>
    </button>
  );
  const onTabKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.indexOf(tab);
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    setTab(tabs[next]);
    document.getElementById('idira-tab-' + next)?.focus();
  };
  const page = { limit: '25', offset: offset.trim() };
  const offsetValid = /^(0|[1-9][0-9]{0,5})$/.test(page.offset) && Number(page.offset) <= 100000;
  const searchValid = search.length <= 64 && (search === '' || /^[A-Za-z0-9 ._@/-]+$/.test(search));
  const safeValid = safe.length <= 64 && (safe === '' || /^[A-Za-z0-9 ._@/-]+$/.test(safe));
  const filtersValid = offsetValid && searchValid && safeValid;
  return (
    <div className="conjur-workspace">
      <dl className="conjur-env" aria-label="Privilege Cloud environment">
        <div><dt>CLI</dt><dd className={ready ? 'conjur-env-ok' : 'conjur-env-warn'}>{tool?.status ?? 'Missing'}{tool?.version && ' · ' + tool.version}</dd></div>
        <div><dt>Profile</dt><dd>Vendor-owned; check session below</dd></div>
        <div><dt>PAM session</dt><dd className="conjur-env-warn">Not verified</dd></div>
        <div><dt>Access</dt><dd>Read-only Safes and account metadata</dd></div>
        <div className="conjur-env-actions">
          <button type="button" className="secondary-button" onClick={onOpenDiagnostics}>Diagnostics</button>
        </div>
      </dl>
      {!ready && <p role="status" className="conjur-setup-notice"><strong>CLI setup needed.</strong> Only approved existing idsec installations are supported. Installing the CLI does not sign in to PAM.</p>}
      <div className="output-tabs conjur-tabs" role="tablist" aria-label="Idira PAM sections" onKeyDown={onTabKeys}>
        {tabs.map((name, index) => (
          <button type="button" key={name} id={'idira-tab-' + index} role="tab"
            aria-selected={tab === name} aria-controls={'idira-panel-' + index} tabIndex={tab === name ? 0 : -1}
            onClick={() => setTab(name)}>{name}</button>
        ))}
      </div>
      {tabs.map((name, index) => (
        <section key={name} id={'idira-panel-' + index} role="tabpanel" aria-labelledby={'idira-tab-' + index}
          className="conjur-panel" hidden={tab !== name}>
          {name === 'Overview' && (
            <>
              <h3>Privilege Cloud overview</h3>
              <p>Inventory is fetched only when you explicitly open and run a reviewed task. No vendor command runs when this page loads.</p>
              <div className="conjur-action-list">
                {action('session-status', 'Check vendor session', 'Read local idsec profile and token-readiness state; no tokens or endpoints are shown.')}
                {action('list-safes', 'Browse Safes', 'Open bounded Safe metadata discovery.', { limit: '25', offset: '0' })}
                {action('list-accounts', 'Browse account metadata', 'Open bounded account inventory without credentials.', { limit: '25', offset: '0' })}
              </div>
            </>
          )}
          {(name === 'Safes' || name === 'Accounts') && (
            <>
              <h3>{name === 'Safes' ? 'Safe inventory' : 'Account inventory'}</h3>
              <p>Use vetted server-side pagination and filters. Results appear in the existing run output explorer after the read finishes.</p>
              <div className="conjur-action-list">
                <label htmlFor={searchID + '-' + name}>Name search</label>
                <input id={searchID + '-' + name} value={search} maxLength={64} onChange={(event) => setSearch(event.target.value)} placeholder="Optional" />
                {name === 'Accounts' && <>
                  <label htmlFor={safeID}>Safe name</label>
                  <input id={safeID} value={safe} maxLength={64} onChange={(event) => setSafe(event.target.value)} placeholder="Optional" />
                </>}
                <label htmlFor={offsetID + '-' + name}>Result offset</label>
                <input id={offsetID + '-' + name} inputMode="numeric" value={offset} onChange={(event) => setOffset(event.target.value)} />
                {!filtersValid && <p role="alert">Use an offset from 0 to 100000 and plain-text filters no longer than 64 characters.</p>}
                <button type="button" disabled={!ready || !filtersValid || !task(name === 'Safes' ? 'list-safes' : 'list-accounts')}
                  onClick={() => open(name === 'Safes' ? 'list-safes' : 'list-accounts', {
                    ...page, ...(search ? {search} : {}), ...(name === 'Accounts' && safe ? {safe} : {}),
                  })}>Prepare 25-item read-only page</button>
              </div>
              {onOpenRuns && <button type="button" className="secondary-button" onClick={onOpenRuns}>View previous run results</button>}
            </>
          )}
          {name === 'Connection' && (
            <>
              <h3>Connection &amp; diagnostics</h3>
              <p>CLI discovery does not prove PAM authentication. Check the vendor-owned session after signing in through an approved external terminal.</p>
              <div className="conjur-action-list">
                {action('version', 'Show idsec version', 'Read local version only.')}
                {action('session-status', 'Check selected profile', 'Read a sanitized profile name and authentication boolean.')}
              </div>
              <p>For an expired or absent session, use the official <code>idsec configure</code> and <code>idsec login</code> flow in a separate, organization-approved terminal, then repeat the session check.</p>
              <button type="button" className="secondary-button" onClick={onOpenDiagnostics}>Open CLI diagnostics</button>
            </>
          )}
        </section>
      ))}
    </div>
  );
}

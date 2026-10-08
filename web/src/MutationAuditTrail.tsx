import { useState } from 'react';
import { fetchAuditTrail, type MutationAuditEntry } from './api/audit';

export function MutationAuditTrail() {
 const [opened,setOpened] = useState(false);
 const [loading,setLoading] = useState(false);
 const [entries,setEntries] = useState<MutationAuditEntry[]>([]);
 const [failed,setFailed] = useState(false);
 const load = async () => {
  setOpened(true); setLoading(true); setFailed(false);
  try { setEntries(await fetchAuditTrail()); }
  catch { setFailed(true); }
  finally { setLoading(false); }
 };
 return <section className="panel mutation-audit" aria-labelledby="audit-trail-heading">
   <div className="panel-heading-row">
    <div>
     <p className="status-label">Durable local evidence</p>
     <h2 id="audit-trail-heading">Mutation audit trail</h2>
     <p>Approved changes and their execution outcomes are recorded on this computer, even after CLIHarbor restarts.</p>
    </div>
    <button type="button" className="secondary-button" disabled={loading} onClick={() => void load()}>{opened ? 'Refresh audit' : 'View audit trail'}</button>
   </div>
   <p className="overview-hint">The journal excludes command output and credentials. An approved entry without completion may indicate an interrupted or unverified operation. Check the target before retrying.</p>
   {loading && <p role="status">Loading audit entries…</p>}
   {failed && <p role="alert">Audit trail unavailable. Do not assume an operation was undone or completed.</p>}
   {opened && !loading && !failed && entries.length===0 && <p role="status">No mutation approvals have been recorded.</p>}
   {opened && !loading && !failed && entries.length>0 && (
    <ol className="mutation-audit-list">
     {entries.map(entry => <li key={entry.sequence}>
      <div className="mutation-audit-title">
       <strong>{entry.action==='approved' ? 'Approved for execution' : 'Execution recorded'}</strong>
       <span>{new Date(entry.time).toLocaleString()}</span>
      </div>
      <dl>
       <div><dt>Run ID</dt><dd><code>{entry.runId}</code></dd></div>
       {entry.packId && <div><dt>Operation</dt><dd>{entry.packId} / {entry.commandId}</dd></div>}
       {entry.targetLabel && <div><dt>{entry.targetLabel}</dt><dd><code>{entry.target}</code></dd></div>}
       {entry.effect && <div><dt>Expected impact</dt><dd>{entry.effect} ({entry.scope})</dd></div>}
       {entry.status && <div><dt>Outcome</dt><dd>{entry.status}{entry.exitCode === undefined ? '' : ' · exit ' + entry.exitCode}</dd></div>}
      </dl>
      <p className="mutation-audit-recovery">Automatic undo unavailable. Restore only through an independently verified inverse operation and a new approval.</p>
     </li>)}
    </ol>
   )}
 </section>;
}

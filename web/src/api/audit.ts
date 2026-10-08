export interface MutationAuditEntry {
 sequence: number;
 previousHash: string;
 hash: string;
 runId: string;
 time: string;
 action: 'approved' | 'completed';
 packId?: string;
 commandId?: string;
 risk?: 'change' | 'destructive';
 targetLabel?: string;
 target?: string;
 effect?: string;
 scope?: 'single' | 'multiple';
 status?: string;
 exitCode?: number;
 undo: 'not-available';
}
function isRecord(value: unknown): value is Record<string, unknown> {
 return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function readEntry(raw: unknown): MutationAuditEntry {
 if (!isRecord(raw)) throw new Error('Invalid audit response');
 const { sequence, previousHash, hash, runId, time, action, packId, commandId, risk, targetLabel, target, effect, scope, status, exitCode, undo } = raw;
 if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1 ||
     typeof previousHash !== 'string' || typeof hash !== 'string' ||
     typeof runId !== 'string' || !/^[a-f0-9]{32}$/u.test(runId) ||
     typeof time !== 'string' || !Number.isFinite(Date.parse(time)) ||
     (action !== 'approved' && action !== 'completed') || undo !== 'not-available' ||
     (packId !== undefined && typeof packId !== 'string') ||
     (commandId !== undefined && typeof commandId !== 'string') ||
     (risk !== undefined && risk !== 'change' && risk !== 'destructive') ||
     (targetLabel !== undefined && typeof targetLabel !== 'string') ||
     (target !== undefined && typeof target !== 'string') ||
     (effect !== undefined && typeof effect !== 'string') ||
     (scope !== undefined && scope !== 'single' && scope !== 'multiple') ||
     (status !== undefined && typeof status !== 'string') ||
     (exitCode !== undefined && (!Number.isSafeInteger(exitCode) || typeof exitCode !== 'number')) ||
     Object.keys(raw).some((key) => !['sequence','previousHash','hash','runId','time','action','packId','commandId','risk','targetLabel','target','effect','scope','status','exitCode','undo'].includes(key))) {
   throw new Error('Invalid audit response');
 }
 return raw as unknown as MutationAuditEntry;
}
export async function fetchAuditTrail(): Promise<MutationAuditEntry[]> {
 const response = await fetch('/api/v1/audit', { credentials:'same-origin', headers:{Accept:'application/json'} });
 if (!response.ok) throw new Error('Could not load mutation audit trail');
 const payload: unknown = await response.json();
 if (!isRecord(payload) || Object.keys(payload).some((key) => key !== 'entries') || !Array.isArray(payload.entries) || payload.entries.length > 100) {
  throw new Error('Invalid audit response');
 }
 return payload.entries.map(readEntry);
}

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { fetchRuns, type RunSummary } from './api/runs';
import type { Task } from './api/tasks';

interface LocalActivity { title: string; path: string; mutation: boolean; anchor?: string }
interface ActivityValue {
  local: Record<string, LocalActivity>;
  update: (id: string, activity: LocalActivity | null) => void;
  remoteRunning: (running: boolean) => void;
  confirmNavigation: (path: string, from?: string) => boolean;
}
const ActivityContext = createContext<ActivityValue>({
  local: {}, update: () => {}, remoteRunning: () => {}, confirmNavigation: () => true,
});

/** Presentation metadata only: never inputs, output, credentials, or executable paths. */
export function OperationActivityProvider({ children }: { children: ReactNode }) {
  const [local, setLocal] = useState<Record<string, LocalActivity>>({});
  const current = useRef<Record<string, LocalActivity>>({});
  const remote = useRef(false);
  const update = useCallback((id: string, activity: LocalActivity | null) => {
    const next = { ...current.current };
    if (activity) next[id] = activity;
    else delete next[id];
    current.current = next;
    setLocal(next);
  }, []);
  const remoteRunning = useCallback((running: boolean) => { remote.current = running; }, []);
  const confirmNavigation = useCallback((path: string, from = window.location.pathname) => {
    if (!Object.values(current.current).some((item) => item.mutation && item.path === from && item.path !== path)) return true;
    return window.confirm('A change is still in progress. The current CLI step may finish, but later guided steps stop if you leave. Inspect Execution History before retrying. Leave this page?');
  }, []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!remote.current && !Object.values(current.current).some((item) => item.mutation)) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);
  return <ActivityContext value={{ local, update, remoteRunning, confirmNavigation }}>{children}</ActivityContext>;
}

export const useOperationActivity = () => useContext(ActivityContext);

export function useMutationPending(anchor: string): boolean {
  const { local } = useOperationActivity();
  return Object.values(local).some((item) => item.mutation && item.anchor === anchor);
}

export function useWorkingActivity(active: boolean, title: string, mutation: boolean, destination?: string, anchor?: string) {
  const { update } = useOperationActivity();
  const id = useId();
  const [path] = useState(() => window.location.pathname);
  useEffect(() => {
    update(id, active ? { title, mutation, path: destination ?? path, anchor: anchor ?? id } : null);
    return () => update(id, null);
  }, [active, title, mutation, path, destination, anchor, id, update]);
  return id;
}

/** The request's finally block clears this even after its form unmounts. */
export function useMutationActivity() {
  const { update } = useOperationActivity();
  const id = useId();
  return (title: string, anchor?: string) => {
    update(id, { title, path: window.location.pathname, mutation: true, anchor });
    return () => update(id, null);
  };
}

export function OperationActivity({ tasks, onOpen }: { tasks: Task[]; onOpen: (path: string, runId?: string, anchor?: string) => void }) {
  const { local, remoteRunning } = useOperationActivity();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    let pending = false;
    const poll = async () => {
      if (pending || controller.signal.aborted || document.visibilityState === 'hidden') return;
      window.clearTimeout(timer);
      pending = true;
      setRefreshing(true);
      let running = false;
      try {
        const next = await fetchRuns(controller.signal);
        if (controller.signal.aborted) return;
        running = next.some((run) => run.status === 'running');
        remoteRunning(next.some((run) => run.status === 'running' &&
          tasks.find((task) => task.packId === run.packId && task.commandId === run.commandId)?.risk !== 'read'));
        setRuns(next);
        setLoaded(true);
        setUnavailable(false);
      } catch {
        if (!controller.signal.aborted) { setUnavailable(true); setLoaded(true); }
      } finally {
        pending = false;
        if (!controller.signal.aborted) setRefreshing(false);
        if (!controller.signal.aborted) timer = window.setTimeout(() => void poll(), running ? 1000 : 5000);
      }
    };
    refresh.current = () => { void poll(); };
    void poll();
    document.addEventListener('visibilitychange', refresh.current);
    const listener = refresh.current;
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', listener);
    };
  }, [remoteRunning, tasks]);
  const running = runs.filter((run) => run.status === 'running');
  const localWork = Object.values(local);
  const visible = [...running, ...runs.filter((run) => run.status !== 'running').slice(0, 3)];
  return (
    <details className="cli-sessions operation-activity" onKeyDown={(event) => {
      if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); }
    }} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
    }}>
      <summary aria-label="Operation activity">
        {(running.length > 0 || localWork.length > 0) && <span className="work-spinner" aria-hidden="true" />}
        <span aria-live="polite">{unavailable ? 'Activity unavailable' : running.length > 0 ? running.length + ' running' : localWork.length > 0 ? 'Working…' : !loaded ? 'Checking activity…' : 'Activity'}</span>
      </summary>
      <div className="cli-sessions-panel">
        <h2>Operation activity</h2>
        {unavailable && <p>Activity could not be refreshed. Last observed runs are shown.</p>}
        <button type="button" className="secondary-button" aria-busy={refreshing} disabled={refreshing} onClick={() => refresh.current()}>{refreshing ? 'Refreshing…' : 'Refresh activity'}</button>
        <ul>
          {localWork.map((item, index) => {
            return <li key={index}><button type="button" className="secondary-button" onClick={(event) => {
              const leftWorkflow = item.mutation && item.anchor && document.getElementById(item.anchor) === null;
              onOpen(leftWorkflow ? '/runs' : item.path, undefined, leftWorkflow ? undefined : item.anchor);
              event.currentTarget.closest('details')?.removeAttribute('open');
            }}>{item.title} · {item.mutation ? 'View operation' : 'Open workflow'}</button></li>;
          })}
          {visible.map((run) => <li key={run.runId}>
            <div className="cli-session-tool"><strong>{tasks.find((task) => task.packId === run.packId && task.commandId === run.commandId)?.name ?? run.commandId}</strong>
              <span>{run.toolId} · {run.status === 'running' ? 'Running' : run.status === 'exited' && run.exitCode === 0 ? 'Succeeded' : run.status === 'exited' ? 'Failed' : run.status}</span>
            </div>
            <a href={'/runs?run=' + encodeURIComponent(run.runId)} onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault(); onOpen('/runs', run.runId); event.currentTarget.closest('details')?.removeAttribute('open');
            }}>Details</a>
          </li>)}
        </ul>
        {visible.length === 0 && localWork.length === 0 && loaded && !unavailable && <p>No retained CLI runs.</p>}
      </div>
    </details>
  );
}

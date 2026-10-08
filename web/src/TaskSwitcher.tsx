import { useEffect, useMemo, useRef, useState } from 'react';
import type { Task } from './api/tasks';
import { searchableText } from './TaskDiscovery';
import { taskIdentityKey, type TaskPreferences } from './taskPreferences';

interface TaskSwitcherProps {
  tasks: Task[];
  preferences: TaskPreferences;
  onSelect: (key: string) => void;
  onClose: () => void;
}

const maxVisibleResults = 25;

/** A navigation surface only: selecting a result never previews or runs its command. */
export function TaskSwitcher({ tasks, preferences, onSelect, onClose }: TaskSwitcherProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    inputRef.current?.focus();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  const favoriteKeys = useMemo(() => new Set(preferences.favorites.map(taskIdentityKey)), [preferences.favorites]);
  const order = useMemo(() => new Map(
    [...preferences.favorites, ...preferences.recent].map((identity, index) => [taskIdentityKey(identity), index] as const),
  ), [preferences.favorites, preferences.recent]);
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matching = tasks.filter((task) => terms.every((term) => searchableText(task).includes(term)))
    .sort((a, b) => (order.get(taskIdentityKey(a)) ?? Infinity) - (order.get(taskIdentityKey(b)) ?? Infinity));
  const visible = matching.slice(0, maxVisibleResults);

  const pick = (task: Task) => onSelect(task.packId + '/' + task.commandId);

  return (
    <dialog ref={dialogRef} className="task-switcher" aria-labelledby="task-switcher-title"
      aria-describedby="task-switcher-description" onClose={onClose}>
      <div className="task-switcher-heading">
        <div>
          <p className="status-label">Quick navigation</p>
          <h2 id="task-switcher-title">Find a task</h2>
          <p id="task-switcher-description">Search approved CLI workflows. Selecting a task opens its configuration; nothing runs automatically.</p>
        </div>
        <button type="button" className="secondary-button task-switcher-close" onClick={onClose} aria-label="Close task search">Close</button>
      </div>
      <form className="task-switcher-search" onSubmit={(event) => {
        event.preventDefault();
        if (visible[0]) pick(visible[0]);
      }}>
        <label htmlFor="task-switcher-input">Search tasks and CLIs</label>
        <input ref={inputRef} id="task-switcher-input" type="search" autoComplete="off"
          placeholder="Task, CLI, or command name" value={query} onChange={(event) => setQuery(event.target.value)} />
        <p role="status" aria-live="polite">
          {matching.length === 0 ? 'No matching tasks' : `Showing ${visible.length} of ${matching.length} matching tasks`}
        </p>
      </form>
      <div className="task-switcher-results">
        {visible.length === 0 ? (
          <div className="task-switcher-empty">
            <strong>No tasks found</strong>
            <p>Try a different task name, CLI, or command ID.</p>
          </div>
        ) : (
          <ul aria-label="Matching approved tasks">
            {visible.map((task) => (
              <li key={taskIdentityKey(task)}>
                <button type="button" className="task-switcher-item" onClick={() => pick(task)}>
                  <span className="task-switcher-item-heading">
                    <strong>{task.name}</strong>
                    {favoriteKeys.has(taskIdentityKey(task)) && <span className="task-switcher-favorite">★ Favorite</span>}
                  </span>
                  <span className="task-switcher-item-meta">{task.packName} · {task.toolId}</span>
                  {task.description && <span className="task-switcher-item-description">{task.description}</span>}
                  <span className="task-switcher-flags">
                    <span className={`task-risk-badge task-risk-badge--${task.risk}`}>
                      {task.risk === 'read' ? 'Read-only' : task.risk === 'change' ? 'Change · approval required' : 'Destructive · approval required'}
                    </span>
                    {task.requiresAuth && <span className="task-auth-badge">Sign-in required</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="task-switcher-footer">Enter opens the first match · Tab moves between results · Esc closes</p>
    </dialog>
  );
}

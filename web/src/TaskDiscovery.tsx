import { useEffect, useMemo, useRef, useState } from 'react';
import type { Task } from './api/tasks';
import { taskIdentityKey, type TaskPreferences } from './taskPreferences';

interface TaskDiscoveryProps {
  tasks: Task[];
  selectedTaskKey: string;
  preferences: TaskPreferences;
  disabled?: boolean;
  onSelect: (taskKey: string) => void;
  onToggleFavorite: (task: Task) => void;
}

interface TaskSectionProps {
  title: string;
  section: 'favorites' | 'recent' | 'all';
  tasks: Task[];
  selectedTaskKey: string;
  favoriteKeys: Set<string>;
  disabled?: boolean;
  emptyText: string;
  onSelect: (taskKey: string) => void;
  onToggleFavorite: (task: Task) => void;
}

function taskKey(task: Task): string {
  return task.packId + '/' + task.commandId;
}

function searchableText(task: Task): string {
  return [
    task.name,
    task.description ?? '',
    task.packName,
    task.packId,
    task.toolId,
    task.commandId,
  ]
    .join(' ')
    .toLocaleLowerCase();
}

function TaskSection({
  title,
  section,
  tasks,
  selectedTaskKey,
  favoriteKeys,
  disabled,
  emptyText,
  onSelect,
  onToggleFavorite,
}: TaskSectionProps) {
  return (
    <section className="task-discovery-section" aria-labelledby={'task-section-' + section}>
      <div className="task-section-heading">
        <h3 id={'task-section-' + section}>{title}</h3>
        <span>{tasks.length}</span>
      </div>
      {tasks.length === 0 ? (
        <p className="task-section-empty">{emptyText}</p>
      ) : (
        <ul className="task-discovery-list">
          {tasks.map((task) => {
            const key = taskKey(task);
            const favorite = favoriteKeys.has(taskIdentityKey(task));
            return (
              <li key={key} className="task-discovery-row">
                <button
                  type="button"
                  className="task-row-select"
                  data-task-action="select"
                  data-task-key={key}
                  data-task-section={section}
                  aria-current={selectedTaskKey === key ? 'true' : undefined}
                  disabled={disabled}
                  onClick={() => onSelect(key)}
                >
                  <span className="task-row-title">{task.name}</span>
                  <span className="task-row-meta">
                    {task.packName} · {task.toolId} · {task.commandId}
                  </span>
                  {task.description && <span className="task-row-description">{task.description}</span>}
                  {task.requiresAuth && <span className="task-auth-badge">Requires vendor session</span>}
                </button>
                <button
                  type="button"
                  className="favorite-toggle"
                  data-task-action="favorite"
                  data-task-key={key}
                  data-task-section={section}
                  aria-pressed={favorite}
                  aria-label={(favorite ? 'Remove ' : 'Add ') + task.name + (favorite ? ' from favorites' : ' to favorites')}
                  onClick={() => onToggleFavorite(task)}
                >
                  <span aria-hidden="true">{favorite ? '★' : '☆'}</span>
                  <span>Favorite</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function TaskDiscovery({
  tasks,
  selectedTaskKey,
  preferences,
  disabled,
  onSelect,
  onToggleFavorite,
}: TaskDiscoveryProps) {
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const byIdentity = useMemo(
    () => new Map(tasks.map((task) => [taskIdentityKey(task), task] as const)),
    [tasks],
  );
  const favoriteKeys = useMemo(
    () => new Set(preferences.favorites.map(taskIdentityKey)),
    [preferences.favorites],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matches = (task: Task) => normalizedQuery.length === 0 || searchableText(task).includes(normalizedQuery);
  const filteredTasks = tasks.filter(matches);
  const favoriteTasks = preferences.favorites
    .map((identity) => byIdentity.get(taskIdentityKey(identity)))
    .filter((task): task is Task => task !== undefined && matches(task));
  const recentTasks = preferences.recent
    .map((identity) => byIdentity.get(taskIdentityKey(identity)))
    .filter((task): task is Task => task !== undefined && matches(task));

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName))
      ) {
        return;
      }
      event.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener('keydown', focusSearch);
    return () => document.removeEventListener('keydown', focusSearch);
  }, []);

  return (
    <div className="task-discovery" aria-label="Task discovery">
      <div className="task-search">
        <label className="task-search-label" htmlFor="task-search-input">
          Search tasks
        </label>
        <span className="task-search-row">
          <input
            ref={searchRef}
            id="task-search-input"
            type="search"
            value={query}
            placeholder="Name, description, pack, tool, or command"
            aria-describedby="task-search-help"
            onChange={(event) => setQuery(event.target.value)}
          />
          <button
            type="button"
            className="secondary-button"
            disabled={query.length === 0}
            onClick={() => setQuery('')}
          >
            Clear
          </button>
        </span>
        <small id="task-search-help">Press / from this page to focus search.</small>
      </div>

      {filteredTasks.length === 0 && normalizedQuery.length > 0 ? (
        <div className="task-search-empty" role="status">
          <strong>No tasks match “{query.trim()}”.</strong>
          <p>Try a task name, description, pack, tool ID, or command ID.</p>
        </div>
      ) : (
        <div className="task-discovery-sections">
          <TaskSection
            title="Favorites"
            section="favorites"
            tasks={favoriteTasks}
            selectedTaskKey={selectedTaskKey}
            favoriteKeys={favoriteKeys}
            disabled={disabled}
            emptyText={normalizedQuery ? 'No favorites match this search.' : 'No favorites yet.'}
            onSelect={onSelect}
            onToggleFavorite={onToggleFavorite}
          />
          <TaskSection
            title="Recently used"
            section="recent"
            tasks={recentTasks}
            selectedTaskKey={selectedTaskKey}
            favoriteKeys={favoriteKeys}
            disabled={disabled}
            emptyText={normalizedQuery ? 'No recent tasks match this search.' : 'No recently used tasks yet.'}
            onSelect={onSelect}
            onToggleFavorite={onToggleFavorite}
          />
          <TaskSection
            title="All tasks"
            section="all"
            tasks={filteredTasks}
            selectedTaskKey={selectedTaskKey}
            favoriteKeys={favoriteKeys}
            disabled={disabled}
            emptyText="No safe tasks are available."
            onSelect={onSelect}
            onToggleFavorite={onToggleFavorite}
          />
        </div>
      )}
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Task } from './api/tasks';
import { taskIdentityKey, type TaskPreferences } from './taskPreferences';

interface TaskDiscoveryProps {
  tasks: Task[];
  selectedTaskKey: string;
  preferences: TaskPreferences;
  disabled?: boolean;
  /** Start collapsed when the operator already chose a task (e.g. from Overview). */
  collapsed?: boolean;
  toolFilter?: string;
  onFilterChange?: (toolKey: string) => void;
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

export function taskToolKey(task: Pick<Task, 'packId' | 'toolId'>): string {
  return task.packId + '/' + task.toolId;
}

export function searchableText(task: Task): string {
  return [
    task.name,
    task.description ?? '',
    task.packName,
    task.packId,
    task.toolId,
    task.commandId,
    task.risk,
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
                  <span className="task-row-meta">{task.packName}</span>
                  {task.description && <span className="task-row-description">{task.description}</span>}
                  <span className={"task-risk-badge task-risk-badge--" + task.risk}>
                    {task.risk === 'read' ? 'Read' : task.risk === 'change' ? 'Change · approval required' : 'Destructive · approval required'}
                  </span>
                  {task.requiresAuth && <span className="task-auth-badge">Sign-in required</span>}
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
  collapsed = false,
  toolFilter = '',
  onFilterChange,
  onSelect,
  onToggleFavorite,
}: TaskDiscoveryProps) {
  const [query, setQuery] = useState('');
  const [catalogOpen, setCatalogOpen] = useState(!collapsed);
  const catalogRef = useRef<HTMLDetailsElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const select = (key: string) => {
    setCatalogOpen(false);
    summaryRef.current?.focus();
    onSelect(key);
  };

  const byIdentity = useMemo(
    () => new Map(tasks.map((task) => [taskIdentityKey(task), task] as const)),
    [tasks],
  );
  const favoriteKeys = useMemo(
    () => new Set(preferences.favorites.map(taskIdentityKey)),
    [preferences.favorites],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matches = (task: Task) => (toolFilter === '' || taskToolKey(task) === toolFilter) &&
    (normalizedQuery.length === 0 || searchableText(task).includes(normalizedQuery));
  const filteredTasks = tasks.filter(matches);
  const favoriteTasks = preferences.favorites
    .map((identity) => byIdentity.get(taskIdentityKey(identity)))
    .filter((task): task is Task => task !== undefined && matches(task));
  const recentTasks = preferences.recent
    .map((identity) => byIdentity.get(taskIdentityKey(identity)))
    .filter(
      (task): task is Task =>
        task !== undefined &&
        matches(task) &&
        !favoriteKeys.has(taskIdentityKey(task)),
    );

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      // A modal task switcher owns keyboard focus while it is open.
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey ||
          document.querySelector('dialog[open]') !== null) {
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      ) {
        return;
      }
      event.preventDefault();
      setCatalogOpen(true);
      if (catalogRef.current) catalogRef.current.open = true;
      searchRef.current?.focus();
    };
    document.addEventListener('keydown', focusSearch);
    return () => document.removeEventListener('keydown', focusSearch);
  }, []);

  return (
    <details ref={catalogRef} className="task-discovery" aria-label="Task discovery" open={catalogOpen} onToggle={(event) => setCatalogOpen(event.currentTarget.open)}>
      <summary ref={summaryRef} className="task-catalog-summary">
        <span>{catalogOpen ? 'Browse approved tasks' : 'Change task'}</span>
        <span className="task-catalog-selection">{catalogOpen ? `${tasks.length} available` : tasks.find((task) => taskKey(task) === selectedTaskKey)?.name ?? 'Select a task'}</span>
      </summary>
      <div className="task-catalog-body">
      {onFilterChange && (
        <label className="task-category-filter">
          Tool category
          <select value={toolFilter} disabled={disabled} onChange={(event) => onFilterChange(event.target.value)}>
            <option value="">All tools</option>
            {Array.from(new Map(tasks.map((task) => [taskToolKey(task), task])).entries()).map(([key, task]) => (
              <option key={key} value={key}>{task.packName} · {task.toolId}</option>
            ))}
          </select>
        </label>
      )}
      <div className="task-search">
        <div className="task-search-heading">
          <label className="task-search-label" htmlFor="task-search-input">
            Find a task
          </label>
          <span className="task-search-count" role="status" aria-live="polite" aria-atomic="true">
            {normalizedQuery || toolFilter ? filteredTasks.length + ' of ' + tasks.length : tasks.length} task{tasks.length === 1 ? '' : 's'}
          </span>
        </div>
        <span className="task-search-row">
          <input
            ref={searchRef}
            id="task-search-input"
            type="search"
            value={query}
            placeholder="Task, pack, tool, or command"
            aria-describedby="task-search-help"
            onChange={(event) => setQuery(event.target.value)}
          />
          <button
            type="button"
            className="secondary-button"
            disabled={query.length === 0}
            onClick={() => {
              setQuery('');
              searchRef.current?.focus();
            }}
          >
            Clear
          </button>
        </span>
        <small id="task-search-help">Press / to search names, descriptions, packs, tools, or commands.</small>
      </div>

      {filteredTasks.length === 0 && (normalizedQuery.length > 0 || toolFilter !== '') ? (
        <div className="task-search-empty" role="status">
          <strong>{normalizedQuery ? `No tasks match “${query.trim()}”.` : 'No tasks are available in this category.'}</strong>
          <p>Try another search or choose All tools.</p>
        </div>
      ) : normalizedQuery ? (
        <div className="task-discovery-sections" role="region" aria-label="Task catalog" tabIndex={0}>
          <TaskSection
            title="Search results"
            section="all"
            tasks={filteredTasks}
            selectedTaskKey={selectedTaskKey}
            favoriteKeys={favoriteKeys}
            disabled={disabled}
            emptyText="No safe tasks are available."
            onSelect={select}
            onToggleFavorite={onToggleFavorite}
          />
        </div>
      ) : (
        <div className="task-discovery-sections" role="region" aria-label="Task catalog" tabIndex={0}>
          {favoriteTasks.length > 0 && (
            <TaskSection
              title="Favorites"
              section="favorites"
              tasks={favoriteTasks}
              selectedTaskKey={selectedTaskKey}
              favoriteKeys={favoriteKeys}
              disabled={disabled}
              emptyText="No favorites yet."
              onSelect={select}
              onToggleFavorite={onToggleFavorite}
            />
          )}
          {recentTasks.length > 0 && (
            <TaskSection
              title="Recently used"
              section="recent"
              tasks={recentTasks}
              selectedTaskKey={selectedTaskKey}
              favoriteKeys={favoriteKeys}
              disabled={disabled}
              emptyText="No recently used tasks yet."
              onSelect={select}
              onToggleFavorite={onToggleFavorite}
            />
          )}
          <TaskSection
            title="All tasks"
            section="all"
            tasks={filteredTasks}
            selectedTaskKey={selectedTaskKey}
            favoriteKeys={favoriteKeys}
            disabled={disabled}
            emptyText="No safe tasks are available."
            onSelect={select}
            onToggleFavorite={onToggleFavorite}
          />
        </div>
      )}
      </div>
    </details>
  );
}

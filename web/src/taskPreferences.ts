import type { Task } from './api/tasks';

export interface TaskIdentity {
  packId: string;
  commandId: string;
}

export interface TaskPreferences {
  favorites: TaskIdentity[];
  recent: TaskIdentity[];
}

export const TASK_PREFERENCES_STORAGE_KEY = 'cliharbor.task-preferences.v1';
export const MAX_RECENT_TASKS = 8;

const STORAGE_VERSION = 1;
const MAX_FAVORITES = 100;
const MAX_PERSISTED_ENTRIES = 128;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_SERIALIZED_LENGTH = 16_384;

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function emptyTaskPreferences(): TaskPreferences {
  return { favorites: [], recent: [] };
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    !hasControlCharacter(value)
  );
}

function parseIdentity(value: unknown): TaskIdentity | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (!validIdentifier(record.packId) || !validIdentifier(record.commandId)) {
    return null;
  }
  return { packId: record.packId, commandId: record.commandId };
}

export function taskIdentityKey(identity: TaskIdentity): string {
  return JSON.stringify([identity.packId, identity.commandId]);
}

function dedupe(identities: TaskIdentity[], limit: number): TaskIdentity[] {
  const seen = new Set<string>();
  const result: TaskIdentity[] = [];
  for (const identity of identities) {
    const key = taskIdentityKey(identity);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(identity);
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}

function parsePreferences(value: unknown): TaskPreferences | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== STORAGE_VERSION ||
    !Array.isArray(record.favorites) ||
    !Array.isArray(record.recent) ||
    record.favorites.length > MAX_PERSISTED_ENTRIES ||
    record.recent.length > MAX_PERSISTED_ENTRIES
  ) {
    return null;
  }

  const favorites: TaskIdentity[] = [];
  for (const item of record.favorites) {
    const identity = parseIdentity(item);
    if (identity === null) {
      return null;
    }
    favorites.push(identity);
  }

  const recent: TaskIdentity[] = [];
  for (const item of record.recent) {
    const identity = parseIdentity(item);
    if (identity === null) {
      return null;
    }
    recent.push(identity);
  }

  return {
    favorites: dedupe(favorites, MAX_FAVORITES),
    recent: dedupe(recent, MAX_RECENT_TASKS),
  };
}

function browserStorage(): PreferenceStorage | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadTaskPreferences(storage: PreferenceStorage | null = browserStorage()): TaskPreferences {
  if (storage === null) {
    return emptyTaskPreferences();
  }
  try {
    const raw = storage.getItem(TASK_PREFERENCES_STORAGE_KEY);
    if (raw === null || raw.length > MAX_SERIALIZED_LENGTH) {
      return emptyTaskPreferences();
    }
    const parsed = parsePreferences(JSON.parse(raw));
    return parsed ?? emptyTaskPreferences();
  } catch {
    return emptyTaskPreferences();
  }
}

export function saveTaskPreferences(
  preferences: TaskPreferences,
  storage: PreferenceStorage | null = browserStorage(),
): void {
  if (storage === null) {
    return;
  }
  const payload = JSON.stringify({
    version: STORAGE_VERSION,
    favorites: dedupe(preferences.favorites, MAX_FAVORITES),
    recent: dedupe(preferences.recent, MAX_RECENT_TASKS),
  });
  if (payload.length > MAX_SERIALIZED_LENGTH) {
    return;
  }
  try {
    storage.setItem(TASK_PREFERENCES_STORAGE_KEY, payload);
  } catch {
    // Preference persistence is optional. Runtime task authority is unaffected.
  }
}

function identityFromTask(task: Task): TaskIdentity | null {
  if (!validIdentifier(task.packId) || !validIdentifier(task.commandId)) {
    return null;
  }
  return { packId: task.packId, commandId: task.commandId };
}

export function reconcileTaskPreferences(preferences: TaskPreferences, tasks: Task[]): TaskPreferences {
  const catalog = new Set(
    tasks
      .map(identityFromTask)
      .filter((identity): identity is TaskIdentity => identity !== null)
      .map(taskIdentityKey),
  );
  return {
    favorites: preferences.favorites.filter((identity) => catalog.has(taskIdentityKey(identity))),
    recent: preferences.recent
      .filter((identity) => catalog.has(taskIdentityKey(identity)))
      .slice(0, MAX_RECENT_TASKS),
  };
}

export function toggleFavoriteTask(preferences: TaskPreferences, task: Task): TaskPreferences {
  const identity = identityFromTask(task);
  if (identity === null) {
    return preferences;
  }
  const key = taskIdentityKey(identity);
  if (preferences.favorites.some((favorite) => taskIdentityKey(favorite) === key)) {
    return {
      ...preferences,
      favorites: preferences.favorites.filter((favorite) => taskIdentityKey(favorite) !== key),
    };
  }
  return {
    ...preferences,
    favorites: dedupe([identity, ...preferences.favorites], MAX_FAVORITES),
  };
}

export function recordRecentTask(preferences: TaskPreferences, task: Task): TaskPreferences {
  const identity = identityFromTask(task);
  if (identity === null) {
    return preferences;
  }
  const key = taskIdentityKey(identity);
  return {
    ...preferences,
    recent: [identity, ...preferences.recent.filter((recent) => taskIdentityKey(recent) !== key)].slice(
      0,
      MAX_RECENT_TASKS,
    ),
  };
}

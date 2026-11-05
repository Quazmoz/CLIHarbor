import { describe, expect, test, vi } from 'vitest';
import type { Task } from './api/tasks';
import {
  MAX_RECENT_TASKS,
  TASK_PREFERENCES_STORAGE_KEY,
  emptyTaskPreferences,
  loadRuntimeTaskPreferences,
  loadTaskPreferences,
  recordRecentTask,
  reconcileTaskPreferences,
  saveTaskPreferences,
  toggleFavoriteTask,
} from './taskPreferences';

function task(packId: string, commandId: string): Task {
  return {
    packId,
    packName: packId,
    commandId,
    name: commandId,
    toolId: 'tool',
    risk: 'read',
    inputs: [],
  };
}

function memoryStorage(initial: string | null = null) {
  let value = initial;
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_key: string, next: string) => {
      value = next;
    }),
    current: () => value,
  };
}

describe('task preferences', () => {
  test('persist through the runtime because each launch is a new browser origin', async () => {
    const stored = '{"version":1,"favorites":[{"packId":"fixture","commandId":"inspect"}],"recent":[]}';
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(init?.method === 'PUT' ? new Response(null, { status: 204 }) : new Response(stored, { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    try {
      fetchMock.mockImplementationOnce(() => Promise.resolve(new Response('unavailable', { status: 500 })));
      expect(await loadRuntimeTaskPreferences('csrf-prefs')).toBe(false);
      saveTaskPreferences(emptyTaskPreferences());
      expect(fetchMock).toHaveBeenCalledTimes(1); // an unread store is never overwritten
      fetchMock.mockClear();

      expect(await loadRuntimeTaskPreferences('csrf-prefs')).toBe(true);
      const loaded = loadTaskPreferences();
      expect(loaded.favorites).toEqual([{ packId: 'fixture', commandId: 'inspect' }]);

      saveTaskPreferences(loaded);
      expect(fetchMock).toHaveBeenCalledTimes(1); // unchanged document: no write

      saveTaskPreferences(emptyTaskPreferences());
      const put = fetchMock.mock.calls[1]!;
      expect(put[0]).toBe('/api/v1/preferences');
      expect(put[1]).toMatchObject({ method: 'PUT', headers: { 'X-CLIHarbor-CSRF': 'csrf-prefs' } });
      expect(JSON.parse(String(put[1]!.body))).toEqual({ version: 1, favorites: [], recent: [] });
    } finally {
      vi.unstubAllGlobals();
    }
  });


  test('round-trips only versioned task identities', () => {
    const storage = memoryStorage();
    const preferences = {
      favorites: [{ packId: 'pack-a', commandId: 'read' }],
      recent: [{ packId: 'pack-b', commandId: 'inspect' }],
    };
    saveTaskPreferences(preferences, storage);
    expect(storage.setItem).toHaveBeenCalledWith(TASK_PREFERENCES_STORAGE_KEY, expect.any(String));
    expect(loadTaskPreferences(storage)).toEqual(preferences);
    expect(storage.current()).not.toContain('argv');
    expect(storage.current()).not.toContain('executable');
  });

  test('malformed, wrong-type, oversized, or unavailable storage fails closed', () => {
    expect(loadTaskPreferences(memoryStorage('{bad json'))).toEqual(emptyTaskPreferences());
    expect(
      loadTaskPreferences(memoryStorage(JSON.stringify({ version: 1, favorites: 'wrong', recent: [] }))),
    ).toEqual(emptyTaskPreferences());
    expect(loadTaskPreferences(memoryStorage('x'.repeat(20_000)))).toEqual(emptyTaskPreferences());

    const throwing = {
      getItem: vi.fn(() => {
        throw new Error('blocked');
      }),
      setItem: vi.fn(() => {
        throw new Error('blocked');
      }),
    };
    expect(loadTaskPreferences(throwing)).toEqual(emptyTaskPreferences());
    expect(() => saveTaskPreferences(emptyTaskPreferences(), throwing)).not.toThrow();
  });

  test('favorites add and remove by stable pack and command identity', () => {
    const target = task('pack-a', 'read');
    const added = toggleFavoriteTask(emptyTaskPreferences(), target);
    expect(added.favorites).toEqual([{ packId: 'pack-a', commandId: 'read' }]);
    expect(toggleFavoriteTask(added, target).favorites).toEqual([]);
  });

  test('recent tasks are deduplicated, most-recent-first, and bounded', () => {
    let preferences = emptyTaskPreferences();
    for (let index = 0; index < MAX_RECENT_TASKS + 4; index += 1) {
      preferences = recordRecentTask(preferences, task('pack', 'command-' + index));
    }
    expect(preferences.recent).toHaveLength(MAX_RECENT_TASKS);
    expect(preferences.recent[0]).toEqual({
      packId: 'pack',
      commandId: 'command-' + (MAX_RECENT_TASKS + 3),
    });

    preferences = recordRecentTask(preferences, task('pack', 'command-7'));
    expect(preferences.recent[0]).toEqual({ packId: 'pack', commandId: 'command-7' });
    expect(preferences.recent.filter((item) => item.commandId === 'command-7')).toHaveLength(1);
  });

  test('stale identities are removed and never create catalog authority', () => {
    const current = [task('current', 'read')];
    const reconciled = reconcileTaskPreferences(
      {
        favorites: [
          { packId: 'stale', commandId: 'gone' },
          { packId: 'current', commandId: 'read' },
        ],
        recent: [{ packId: 'stale', commandId: 'gone' }],
      },
      current,
    );
    expect(reconciled).toEqual({
      favorites: [{ packId: 'current', commandId: 'read' }],
      recent: [],
    });
  });
});

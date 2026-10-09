import { afterEach, describe, expect, test, vi } from 'vitest';
import { fetchTasks } from './tasks';

afterEach(() => vi.unstubAllGlobals());

function task(commandId: string, packId = 'fixture') {
  return {
    packId,
    packName: packId,
    commandId,
    name: commandId,
    toolId: 'fixture',
    risk: 'read',
    inputs: [{ id: 'target', type: 'string', label: 'Target', required: true,
      validation: { minLength: 1, maxLength: 128, disallowLeadingDash: true } }],
  };
}

function load(tasks: unknown[]): Promise<unknown> {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(
    new Response(JSON.stringify({ tasks }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  )));
  return fetchTasks();
}

describe('fetchTasks catalog integrity for every CLI', () => {
  test('accepts distinct packs even when commands use the same identifier', async () => {
    const tasks = [
      task('inspect', 'cyberark-conjur-v9'),
      task('inspect', 'docker-cli'),
      task('inspect', 'kubectl-cli'),
      task('inspect', 'github-cli'),
    ];
    await expect(load(tasks)).resolves.toMatchObject(tasks);
  });

  test('rejects identical pack/command identity instead of ambiguously selecting a CLI task', async () => {
    await expect(load([task('inspect'), task('inspect')])).rejects.toMatchObject({
      detail: { code: 'invalid_response' },
    });
  });

  test('rejects repeated input IDs and overlarge task form definitions', async () => {
    const repeated = task('inspect');
    repeated.inputs.push({ ...repeated.inputs[0] });
    await expect(load([repeated])).rejects.toMatchObject({
      detail: { code: 'invalid_response' },
    });
    await expect(load([{ ...task('inspect'), inputs: Array.from({ length: 65 },
      (_, i) => ({ id: 'field-' + i, type: 'string', label: 'Field' })) }]))
      .rejects.toMatchObject({ detail: { code: 'invalid_response' } });
  });

  test.each([
    { minLength: -1 }, { maxLength: 4097 },
    { minLength: 4, maxLength: 2 },
    { min: 9, max: 5 },
    { min: Number.MAX_SAFE_INTEGER + 1 },
    { max: 1.5 },
    { pattern: 'a'.repeat(257) },
    { enum: [] },
    { enum: ['read', 'read'] },
    { enum: Array.from({ length: 65 }, (_, i) => 'option-' + i) },
    { enum: ['a'.repeat(257)] },
    { unknownConstraint: true },
  ])('fails closed on malformed input validation metadata: %j', async (validation) => {
    await expect(load([{ ...task('inspect'), inputs: [{
      id: 'target', type: 'string', label: 'Target', validation,
    }] }])).rejects.toMatchObject({ detail: { code: 'invalid_response' } });
  });

  test.each(['../escape', '__proto__', 'UPPERCASE', ''])(
    'rejects invalid form input ID %j', async (id) => {
      await expect(load([{ ...task('inspect'), inputs: [{ id, type: 'string', label: 'Target' }] }]))
        .rejects.toMatchObject({ detail: { code: 'invalid_response' } });
    });

  test('allows schema-boundary numeric constraints and 64 unique choices', async () => {
    const valid = task('inspect');
    valid.inputs = [{
      id: 'target', type: 'string', label: 'Target', required: true,
      validation: { min: -10, max: 10, minLength: 0, maxLength: 4096,
        enum: Array.from({ length: 64 }, (_, i) => 'v' + i) },
    }];
    await expect(load([valid])).resolves.toMatchObject([valid]);
  });

  test('does not weaken change/destructive impact requirements', async () => {
    const malformed = { ...task('remove'), risk: 'destructive' };
    await expect(load([malformed])).rejects.toMatchObject({
      detail: { code: 'invalid_response' },
    });
    const impact = {
      targetInput: 'target', targetLabel: 'Target',
      effect: 'Updates approved target', scope: 'single',
    };
    await expect(load([{ ...task('apply'), risk: 'change', impact }]))
      .resolves.toMatchObject([{ risk: 'change', impact }]);
  });
});

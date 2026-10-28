import { describe, expect, test } from 'vitest';
import { preparePackDraft, type DraftFields } from './packDraft';
import policy from '../../internal/packs/testdata/executable-policy.json';

const valid: DraftFields = {
  packId: 'acme-cli',
  name: 'Acme CLI',
  toolId: 'acme',
  executable: 'acme',
  platforms: ['windows', 'darwin'],
};

describe('pack authoring preview', () => {
  test('generates only an inert discovery-only v1 pack with canonical ordering', () => {
    const result = preparePackDraft(valid);
    expect(result.issues).toEqual([]);
    expect(result.yaml).toContain('apiVersion: cliharbor.dev/v1\nkind: CliPack');
    expect(result.yaml).toContain('  platforms: [windows, darwin]');
    expect(result.yaml).toContain('      executableNames: ["acme"]');
    expect(result.yaml).toMatch(/commands: \{\}\n$/);
    expect(result.yaml).not.toContain('argv:');
    expect(result.yaml).not.toContain('versionProbe:');
    expect(result.yaml).not.toContain('install:');
  });

  test('rejects a duplicate pack identity', () => {
    expect(preparePackDraft(valid, ['acme-cli']).yaml).toBeNull();
  });
  test('agrees with the backend executable policy contract', () => {
    for (const executable of policy.accept) {
      expect(preparePackDraft({ ...valid, executable }).issues, executable).toEqual([]);
    }
    for (const executable of policy.reject) {
      const result = preparePackDraft({ ...valid, executable });
      expect(result.yaml, executable).toBeNull();
      expect(result.issues.some((issue) => issue.field === 'executable'), executable).toBe(true);
    }
    // Go parses this exact YAML in TestExecutablePolicyContract.
    const { yaml } = preparePackDraft(policy.draft.fields as DraftFields);
    expect(yaml).toBe(policy.draft.yaml);
  });

  test('rejects invalid ids, control characters, empty or duplicate OS selection', () => {
    expect(preparePackDraft({ ...valid, packId: '../bad', toolId: 'UPPER' }).issues.map((x) => x.field))
      .toEqual(['packId', 'toolId']);
    expect(preparePackDraft({ ...valid, name: 'Bad\nname' }).yaml).toBeNull();
    expect(preparePackDraft({ ...valid, platforms: [] }).yaml).toBeNull();
    expect(preparePackDraft({ ...valid, platforms: ['linux', 'linux'] }).yaml).toBeNull();
  });

  test('quotes presentation text so it cannot insert YAML nodes or executable commands', () => {
    const name = 'CLI: "safe" # example';
    const result = preparePackDraft({ ...valid, name });
    expect(result.yaml).toContain('  name: ' + JSON.stringify(name));
    expect(result.yaml?.match(/^commands:/gm)).toHaveLength(1);
    expect(result.yaml?.match(/^runtime:/gm)).toHaveLength(1);
  });
});

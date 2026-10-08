import { describe, expect, test } from 'vitest';
import { preparePackDraft, type DraftFields } from './packDraft';

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

  test('rejects duplicate pack identity, invalid paths, scripts and interpreter basenames', () => {
    expect(preparePackDraft(valid, ['acme-cli']).yaml).toBeNull();
    for (const executable of ['../acme', 'C:\\tools\\acme.exe', 'cmd.exe', 'pwsh', 'bash', 'thing.ps1']) {
      const result = preparePackDraft({ ...valid, executable });
      expect(result.yaml, executable).toBeNull();
      expect(result.issues.some((issue) => issue.field === 'executable')).toBe(true);
    }
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

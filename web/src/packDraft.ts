/**
 * Browser-only authoring aid. Produces inert, discovery-only YAML; it cannot
 * register a trusted pack or grant the browser executable/argv authority.
 * Native 'pack validate' remains the authoritative schema/security check.
 */
export type DraftPlatform = 'windows' | 'linux' | 'darwin';

export interface DraftFields {
  packId: string;
  name: string;
  toolId: string;
  executable: string;
  platforms: DraftPlatform[];
}

export interface DraftIssue {
  field: keyof DraftFields;
  message: string;
}

const idPattern = /^[a-z][a-z0-9-]{0,62}$/;
const executablePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const platformOrder: DraftPlatform[] = ['windows', 'linux', 'darwin'];
// Advisory mirror of isForbiddenExecutable (internal/packs/validation.go);
// internal/packs/testdata/executable-policy.json pins both to the same verdicts.
const windowsScriptExtension = /\.(?:bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta)$/;
const forbiddenExecutable = /^(?:cmd|powershell|pwsh|sh|bash|zsh|fish|dash|ksh|csh|tcsh|wscript|cscript|osascript|mshta|rundll32|regsvr32|wsl|env|xargs|sudo|doas|runas|busybox|nohup|nice|timeout|stdbuf|setsid)$/;
const versionedInterpreter = /^(?:python|pythonw|py|perl|ruby|node|java|javaw)[0-9.]*$/;
function isUnsafeExecutable(name: string): boolean {
  const lower = name.toLowerCase();
  if (windowsScriptExtension.test(lower)) return true;
  const base = lower.replace(/\.(?:exe|com)$/, '');
  return forbiddenExecutable.test(base) || versionedInterpreter.test(base);
}
function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || (code >= 127 && code <= 159);
  });
}

export function preparePackDraft(fields: DraftFields, registeredPackIds: readonly string[] = []): {
  yaml: string | null;
  issues: DraftIssue[];
} {
  const packId = fields.packId.trim();
  const toolId = fields.toolId.trim();
  const name = fields.name.trim();
  const executable = fields.executable.trim();
  const platforms = platformOrder.filter((p) => fields.platforms.includes(p));
  const issues: DraftIssue[] = [];

  if (!idPattern.test(packId)) {
    issues.push({ field: 'packId', message: 'Use 1–63 lowercase letters, digits or hyphens, starting with a letter.' });
  } else if (registeredPackIds.includes(packId)) {
    issues.push({ field: 'packId', message: 'This pack ID is already loaded. Choose a unique ID.' });
  }
  if (!name || name.length > 120 || hasControlCharacters(name)) {
    issues.push({ field: 'name', message: 'Enter a display name of at most 120 characters without control characters.' });
  }
  if (!idPattern.test(toolId)) {
    issues.push({ field: 'toolId', message: 'Use 1–63 lowercase letters, digits or hyphens, starting with a letter.' });
  }
  if (!executablePattern.test(executable) || isUnsafeExecutable(executable)) {
    issues.push({
      field: 'executable',
      message: 'Enter an executable basename, not a path, Windows script, shell, interpreter, or program launcher.',
    });
  }
  if (fields.platforms.length !== platforms.length || platforms.length === 0) {
    issues.push({ field: 'platforms', message: 'Select at least one supported operating system, without duplicates.' });
  }
  if (issues.length > 0) return { yaml: null, issues };

  // JSON-quoted scalar strings are valid YAML; user text cannot add keys,
  // YAML tags, anchors, extra documents, or executable command definitions.
  const yaml = [
    'apiVersion: cliharbor.dev/v1',
    'kind: CliPack',
    'metadata:',
    '  id: ' + packId,
    '  name: ' + JSON.stringify(name),
    '  version: 0.1.0',
    '  description: "Discovery-only draft. Add separately reviewed deterministic CLI commands."',
    'runtime:',
    '  platforms: [' + platforms.join(', ') + ']',
    '  tools:',
    '    ' + toolId + ':',
    '      executableNames: [' + JSON.stringify(executable) + ']',
    'commands: {}',
    '',
  ].join('\n');
  return { yaml, issues };
}

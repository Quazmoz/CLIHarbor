import { describe, expect, test } from 'vitest';
import { describeToolReadiness, inputGuidance, runOutcomeHeading, runOutcomeTone } from './operatorLanguage';
import type { TaskInput } from './api/tasks';
import type { ToolDiagnostic } from './api/tools';

function tool(status: ToolDiagnostic['status'], extra: Partial<ToolDiagnostic> = {}): ToolDiagnostic {
  return {
    packId: 'fixture',
    packName: 'Fixture CLI',
    packVersion: '1.0.0',
    toolId: 'fixture',
    status,
    ...extra,
  };
}

describe('operator language', () => {
  test('turns diagnostic states into plain-language next actions without inventing authority', () => {
    expect(describeToolReadiness(tool('missing', { install: { version: '1.2.3', customLocation: true } }))).toMatchObject({
      heading: "Fixture CLI isn't available yet",
      statusText: 'Setup needed',
      ready: false,
    });
    expect(describeToolReadiness(tool('ambiguous')).nextStep).toContain('explicit tool path');
    expect(describeToolReadiness(tool('identity-failed')).nextStep).toContain('Do not bypass application controls');
  });

  test('derives input guidance only from existing declarative validation metadata', () => {
    const integer: TaskInput = {
      id: 'limit',
      label: 'Limit',
      type: 'integer',
      required: true,
      validation: { min: 1, max: 25 },
    };
    const text: TaskInput = {
      id: 'name',
      label: 'Name',
      type: 'string',
      validation: { maxLength: 64, disallowLeadingDash: true, pattern: '^[a-z]+$' },
    };

    expect(inputGuidance(integer)).toBe('Enter a whole number from 1 to 25.');
    expect(inputGuidance(text)).toContain('Use no more than 64 characters.');
    expect(inputGuidance(text)).toContain('cannot start with a dash');
    expect(inputGuidance(text)).toContain('approved format');
  });

  test('presents non-zero process exit as an operator failure while preserving the backend status separately', () => {
    expect(runOutcomeHeading('exited', 0)).toBe('Succeeded');
    expect(runOutcomeTone('exited', 0)).toBe('succeeded');
    expect(runOutcomeHeading('exited', 17)).toBe('Failed');
    expect(runOutcomeTone('exited', 17)).toBe('failed');
    expect(runOutcomeHeading('timed-out')).toBe('Timed out');
  });
});

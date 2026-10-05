import type { RunStatus } from './api/runs';
import type { TaskInput } from './api/tasks';
import type { ToolDiagnostic, ToolStatus } from './api/tools';

export interface ToolReadinessCopy {
  heading: string;
  statusText: string;
  summary: string;
  nextStep: string;
  ready: boolean;
}

export function toolDisplayName(tool: Pick<ToolDiagnostic, 'packName' | 'toolId'>): string {
  const name = tool.packName.trim();
  return name.length > 0 ? name : tool.toolId;
}

export function describeToolReadiness(tool: ToolDiagnostic): ToolReadinessCopy {
  const name = toolDisplayName(tool);
  const views: Record<ToolStatus, Omit<ToolReadinessCopy, 'ready'>> = {
    ready: {
      heading: name + ' is ready',
      statusText: 'Ready',
      summary: tool.version
        ? 'CLIHarbor verified version ' + tool.version + ' and can use this tool for approved tasks.'
        : 'CLIHarbor verified this tool and can use it for approved tasks.',
      nextStep: tool.requiresVendorSession
        ? 'Check sign-in status before running tasks that require authentication.'
        : 'You can continue to Tasks.',
    },
    missing: {
      heading: name + " isn't available yet",
      statusText: 'Setup needed',
      summary: 'CLIHarbor could not find an approved installation of this tool.',
      nextStep: tool.install
        ? 'Install the verified current-user copy below, then restart CLIHarbor.'
        : 'Use your organization-approved installation path, then restart or relaunch CLIHarbor.',
    },
    ambiguous: {
      heading: name + ' needs an explicit selection',
      statusText: 'Selection needed',
      summary: 'CLIHarbor found more than one matching installation and will not guess which one to use.',
      nextStep: 'Relaunch CLIHarbor with an approved explicit tool path, or remove the ambiguity through your normal software-management process.',
    },
    incompatible: {
      heading: name + ' needs a compatible version',
      statusText: 'Version not supported',
      summary: 'The detected installation does not meet the reviewed version requirement.',
      nextStep: 'Install or select an approved compatible version, then restart CLIHarbor.',
    },
    'probe-failed': {
      heading: name + ' could not be verified',
      statusText: 'Verification failed',
      summary: 'CLIHarbor found the tool but could not safely confirm its version.',
      nextStep: 'Check the approved installation and local application-control policy, then retry after relaunching CLIHarbor.',
    },
    'invalid-override': {
      heading: name + ' has an invalid configured location',
      statusText: 'Location not usable',
      summary: 'The explicit tool location configured for CLIHarbor cannot be used safely.',
      nextStep: 'Correct or remove the explicit tool-path configuration, then relaunch CLIHarbor.',
    },
    'identity-failed': {
      heading: name + ' failed executable verification',
      statusText: 'Verification failed',
      summary: 'The executable changed or could not be revalidated, so CLIHarbor blocked it.',
      nextStep: 'Restore or select the approved installation and relaunch CLIHarbor. Do not bypass application controls.',
    },
    'unsupported-platform': {
      heading: name + ' is not supported on this platform',
      statusText: 'Platform not supported',
      summary: 'The reviewed tool definition does not support this operating system or architecture.',
      nextStep: 'Use a supported platform or an approved pack that explicitly supports this environment.',
    },
  };
  return { ...views[tool.status], ready: tool.status === 'ready' };
}

export function inputGuidance(input: TaskInput): string | undefined {
  const validation = input.validation ?? {};
  const parts: string[] = [];

  if (input.type === 'integer') {
    if (validation.min !== undefined && validation.max !== undefined) {
      parts.push('Enter a whole number from ' + validation.min + ' to ' + validation.max + '.');
    } else if (validation.min !== undefined) {
      parts.push('Enter a whole number of at least ' + validation.min + '.');
    } else if (validation.max !== undefined) {
      parts.push('Enter a whole number no greater than ' + validation.max + '.');
    } else {
      parts.push('Enter a whole number.');
    }
  } else if (input.type === 'enum') {
    parts.push(input.required ? 'Choose one approved value.' : 'Choose one approved value, or leave this unset.');
  } else if (input.type === 'multiselect') {
    parts.push(input.required ? 'Choose one or more values.' : 'Choose any values that apply, or leave this unselected.');
  } else if (input.type === 'boolean') {
    parts.push(input.required ? 'Turn this on when the task should include this option.' : 'Optional. Turn this on only when needed.');
  } else if (input.type === 'secret') {
    if (validation.maxLength !== undefined) {
      parts.push('Use no more than ' + validation.maxLength + ' characters.');
    }
    parts.push('Sent to the CLI on standard input only; never shown, logged, or saved.');
  } else if (input.type === 'string') {
    if (validation.minLength !== undefined && validation.maxLength !== undefined) {
      parts.push('Use ' + validation.minLength + '–' + validation.maxLength + ' characters.');
    } else if (validation.minLength !== undefined) {
      parts.push('Use at least ' + validation.minLength + ' characters.');
    } else if (validation.maxLength !== undefined) {
      parts.push('Use no more than ' + validation.maxLength + ' characters.');
    }
    if (validation.disallowLeadingDash) {
      parts.push('The value cannot start with a dash.');
    }
  }

  if (validation.pattern) {
    parts.push('The value must match the approved format for this task.');
  }

  return parts.length === 0 ? undefined : parts.join(' ');
}

export function runOutcomeHeading(status: RunStatus, exitCode?: number): string {
  switch (status) {
    case 'running':
      return 'Running';
    case 'cancelled':
      return 'Cancelled';
    case 'timed-out':
      return 'Timed out';
    case 'failed':
      return 'Failed';
    case 'exited':
      return exitCode === 0 ? 'Succeeded' : exitCode === undefined ? 'Failed' : `Failed · exit ${exitCode}`;
  }
}

export function runOutcomeTone(status: RunStatus, exitCode?: number): 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed-out' {
  if (status === 'exited') {
    return exitCode === 0 ? 'succeeded' : 'failed';
  }
  return status;
}

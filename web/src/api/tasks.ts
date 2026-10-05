import { clientError, errorFromResponse } from './errors';

export type TaskInputType = 'string' | 'integer' | 'boolean' | 'enum' | 'multiselect' | 'secret';
export type TaskRisk = 'read' | 'change' | 'destructive';
export type TaskImpactScope = 'single' | 'multiple';

export interface TaskImpact {
  targetInput: string;
  targetLabel: string;
  effect: string;
  scope: TaskImpactScope;
}

export interface TaskInputValidation {
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  enum?: string[];
  disallowLeadingDash?: boolean;
}

export interface TaskInput {
  id: string;
  type: TaskInputType;
  label: string;
  required?: boolean;
  validation?: TaskInputValidation;
}

export interface Task {
  packId: string;
  packName: string;
  commandId: string;
  name: string;
  description?: string;
  toolId: string;
  toolVersion?: string;
  risk: TaskRisk;
  impact?: TaskImpact;
  requiresAuth?: boolean;
  inputs: TaskInput[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseTask(value: unknown): Task {
  if (!isRecord(value)) {
    throw clientError('invalid_response');
  }
  const { packId, packName, commandId, name, description, toolId, toolVersion, risk, impact, requiresAuth, inputs } = value;
  if (
    typeof packId !== 'string' ||
    typeof packName !== 'string' ||
    typeof commandId !== 'string' ||
    typeof name !== 'string' ||
    typeof toolId !== 'string' ||
    (description !== undefined && typeof description !== 'string') ||
    (toolVersion !== undefined && typeof toolVersion !== 'string') ||
    (risk !== undefined && !['read', 'change', 'destructive'].includes(String(risk))) ||
    (impact !== undefined && !isRecord(impact)) ||
    (requiresAuth !== undefined && typeof requiresAuth !== 'boolean') ||
    !Array.isArray(inputs)
  ) {
    throw clientError('invalid_response');
  }

  const parsedRisk = (risk ?? 'read') as TaskRisk;
  let parsedImpact: TaskImpact | undefined;
  if (impact !== undefined) {
    const allowedImpact = new Set(['targetInput', 'targetLabel', 'effect', 'scope']);
    if (Object.keys(impact).some((key) => !allowedImpact.has(key))) {
      throw clientError('invalid_response');
    }
    const { targetInput, targetLabel, effect, scope } = impact;
    if (
      typeof targetInput !== 'string' ||
      typeof targetLabel !== 'string' ||
      typeof effect !== 'string' ||
      !['single', 'multiple'].includes(String(scope))
    ) {
      throw clientError('invalid_response');
    }
    parsedImpact = { targetInput, targetLabel, effect, scope: scope as TaskImpactScope };
  }
  if ((parsedRisk === 'change' || parsedRisk === 'destructive') !== (parsedImpact !== undefined)) {
    throw clientError('invalid_response');
  }

  const parsedInputs = inputs.map((input): TaskInput => {
    if (!isRecord(input)) {
      throw clientError('invalid_response');
    }
    const { id, type, label, required, validation } = input;
    if (
      typeof id !== 'string' ||
      typeof label !== 'string' ||
      !['string', 'integer', 'boolean', 'enum', 'multiselect', 'secret'].includes(String(type)) ||
      (required !== undefined && typeof required !== 'boolean') ||
      (validation !== undefined && !isRecord(validation))
    ) {
      throw clientError('invalid_response');
    }

    const parsedValidation: TaskInputValidation = {};
    if (isRecord(validation)) {
      for (const key of ['min', 'max', 'minLength', 'maxLength'] as const) {
        const current = validation[key];
        if (current !== undefined) {
          if (typeof current !== 'number' || !Number.isFinite(current)) {
            throw clientError('invalid_response');
          }
          parsedValidation[key] = current;
        }
      }
      if (validation.pattern !== undefined) {
        if (typeof validation.pattern !== 'string') {
          throw clientError('invalid_response');
        }
        parsedValidation.pattern = validation.pattern;
      }
      if (validation.enum !== undefined) {
        if (!Array.isArray(validation.enum) || validation.enum.some((item) => typeof item !== 'string')) {
          throw clientError('invalid_response');
        }
        parsedValidation.enum = [...validation.enum];
      }
      if (validation.disallowLeadingDash !== undefined) {
        if (typeof validation.disallowLeadingDash !== 'boolean') {
          throw clientError('invalid_response');
        }
        parsedValidation.disallowLeadingDash = validation.disallowLeadingDash;
      }
    }

    return {
      id,
      type: type as TaskInputType,
      label,
      required: required === true,
      validation: parsedValidation,
    };
  });

  return {
    packId,
    packName,
    commandId,
    name,
    description,
    toolId,
    toolVersion,
    risk: parsedRisk,
    impact: parsedImpact,
    requiresAuth: requiresAuth === true,
    inputs: parsedInputs,
  };
}

export async function fetchTasks(signal?: AbortSignal): Promise<Task[]> {
  const response = await fetch('/api/v1/tasks', {
    method: 'GET',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) {
    throw await errorFromResponse(response);
  }
  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload.tasks)) {
    throw clientError('invalid_response');
  }
  return payload.tasks.map(parseTask);
}

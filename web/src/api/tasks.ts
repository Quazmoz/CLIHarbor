export type TaskInputType = 'string' | 'integer' | 'boolean' | 'enum' | 'multiselect';

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
  inputs: TaskInput[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseTask(value: unknown): Task {
  if (!isRecord(value)) {
    throw new Error('CLIHarbor returned invalid task metadata.');
  }
  const { packId, packName, commandId, name, description, toolId, toolVersion, inputs } = value;
  if (
    typeof packId !== 'string' ||
    typeof packName !== 'string' ||
    typeof commandId !== 'string' ||
    typeof name !== 'string' ||
    typeof toolId !== 'string' ||
    (description !== undefined && typeof description !== 'string') ||
    (toolVersion !== undefined && typeof toolVersion !== 'string') ||
    !Array.isArray(inputs)
  ) {
    throw new Error('CLIHarbor returned invalid task metadata.');
  }

  const parsedInputs = inputs.map((input): TaskInput => {
    if (!isRecord(input)) {
      throw new Error('CLIHarbor returned invalid task input metadata.');
    }
    const { id, type, label, required, validation } = input;
    if (
      typeof id !== 'string' ||
      typeof label !== 'string' ||
      !['string', 'integer', 'boolean', 'enum', 'multiselect'].includes(String(type)) ||
      (required !== undefined && typeof required !== 'boolean') ||
      (validation !== undefined && !isRecord(validation))
    ) {
      throw new Error('CLIHarbor returned invalid task input metadata.');
    }

    const parsedValidation: TaskInputValidation = {};
    if (isRecord(validation)) {
      for (const key of ['min', 'max', 'minLength', 'maxLength'] as const) {
        const current = validation[key];
        if (current !== undefined) {
          if (typeof current !== 'number' || !Number.isFinite(current)) {
            throw new Error('CLIHarbor returned invalid task validation metadata.');
          }
          parsedValidation[key] = current;
        }
      }
      if (validation.pattern !== undefined) {
        if (typeof validation.pattern !== 'string') {
          throw new Error('CLIHarbor returned invalid task validation metadata.');
        }
        parsedValidation.pattern = validation.pattern;
      }
      if (validation.enum !== undefined) {
        if (!Array.isArray(validation.enum) || validation.enum.some((item) => typeof item !== 'string')) {
          throw new Error('CLIHarbor returned invalid task validation metadata.');
        }
        parsedValidation.enum = [...validation.enum];
      }
      if (validation.disallowLeadingDash !== undefined) {
        if (typeof validation.disallowLeadingDash !== 'boolean') {
          throw new Error('CLIHarbor returned invalid task validation metadata.');
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
    throw new Error(`CLIHarbor task metadata request failed with HTTP ${response.status}.`);
  }
  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload.tasks)) {
    throw new Error('CLIHarbor returned invalid task metadata.');
  }
  return payload.tasks.map(parseTask);
}

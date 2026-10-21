import { clientError, errorFromResponse } from '../../api/errors';

export interface TerraformState { id: string; name: string }
export interface TerraformProject { id: string; name: string; states: TerraformState[] }
export interface TerraformResource {
  address: string; type: string; module: string; category: 'managed' | 'data';
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function validID(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9-]{1,80}$/.test(value);
}
function validText(value: unknown, max = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max &&
    !/[\u0000-\u001f\u007f]/.test(value);
}
async function read<T>(path: string, key: string, parse: (value: unknown) => T, signal: AbortSignal): Promise<T[]> {
  const response = await fetch(path, { credentials: 'same-origin', headers: { Accept: 'application/json' }, signal });
  if (!response.ok) throw await errorFromResponse(response);
  const payload: unknown = await response.json();
  if (!record(payload) || !Array.isArray(payload[key])) throw clientError('invalid_response');
  if (payload[key].length > (key === 'projects' ? 16 : 5000)) throw clientError('invalid_response');
  return payload[key].map(parse);
}
function parseProject(value: unknown): TerraformProject {
  if (!record(value) || !validID(value.id) || !validText(value.name, 255) || !Array.isArray(value.states)) throw clientError('invalid_response');
  const states: TerraformState[] = value.states.map((state: unknown) => {
    if (!record(state) || !validID(state.id) || !validText(state.name, 255)) throw clientError('invalid_response');
    return { id: state.id, name: state.name };
  });
  if (states.length > 128) throw clientError('invalid_response');
  return { id: value.id, name: value.name, states };
}
function parseResource(value: unknown): TerraformResource {
  if (!record(value) || !validText(value.address) || !validText(value.type, 128) ||
    typeof value.module !== 'string' || value.module.length > 256 ||
    (value.category !== 'managed' && value.category !== 'data')) throw clientError('invalid_response');
  return { address: value.address, type: value.type, module: value.module, category: value.category };
}
export function fetchTerraformProjects(signal: AbortSignal) {
  return read('/api/v1/terraform/projects', 'projects', parseProject, signal);
}
export function fetchTerraformResources(project: string, state: string, signal: AbortSignal) {
  if (!validID(project) || !validID(state)) throw clientError('invalid_response');
  return read('/api/v1/terraform/resources?project=' + encodeURIComponent(project) +
    '&state=' + encodeURIComponent(state), 'resources', parseResource, signal);
}

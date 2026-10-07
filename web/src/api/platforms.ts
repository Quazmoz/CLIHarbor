import { clientError, errorFromResponse } from './errors';

// Closed set shared with internal/platforms/*: the backend names features,
// the frontend owns the routes they open.
export type PlatformFeatureID = 'tasks' | 'sign-in' | 'security-audit';

export interface PlatformFeature {
  id: PlatformFeatureID;
  name: string;
}

/** A dedicated CLI: functionality built and tested for one vendor CLI. */
export interface Platform {
  id: string;
  name: string;
  summary: string;
  packId: string;
  toolId: string;
  ready: boolean;
  features: PlatformFeature[];
}

const featureIDs: ReadonlySet<string> = new Set<PlatformFeatureID>(['tasks', 'sign-in', 'security-audit']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parsePlatform(value: unknown): Platform {
  if (!isRecord(value)) throw clientError('invalid_response');
  const { id, name, summary, packId, toolId, ready, features } = value;
  if (
    typeof id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(id) ||
    typeof name !== 'string' || name.length === 0 ||
    typeof summary !== 'string' ||
    typeof packId !== 'string' || typeof toolId !== 'string' ||
    typeof ready !== 'boolean' || !Array.isArray(features)
  ) {
    throw clientError('invalid_response');
  }
  // Unknown features are dropped rather than rendered: fail closed on ambiguity.
  const parsedFeatures = features.flatMap((feature): PlatformFeature[] =>
    isRecord(feature) && typeof feature.id === 'string' && featureIDs.has(feature.id) && typeof feature.name === 'string'
      ? [{ id: feature.id as PlatformFeatureID, name: feature.name }]
      : [],
  );
  return { id, name, summary, packId, toolId, ready, features: parsedFeatures };
}

export async function fetchPlatforms(signal?: AbortSignal): Promise<Platform[]> {
  const response = await fetch('/api/v1/platforms', {
    method: 'GET',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) throw await errorFromResponse(response);
  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload.platforms)) throw clientError('invalid_response');
  return payload.platforms.map(parsePlatform);
}

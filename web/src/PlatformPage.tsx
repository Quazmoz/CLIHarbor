import type { Platform, PlatformFeatureID } from './api/platforms';
import type { Task } from './api/tasks';

interface PlatformPageProps {
  platform: Platform;
  tasks: Task[];
  onOpenFeature: (feature: PlatformFeatureID) => void;
  onOpenDiagnostics: () => void;
}

const featureDetail: Record<PlatformFeatureID, string> = {
  tasks: 'Approved commands from the reviewed pack, with target context shown before any change runs.',
  'sign-in': 'Guided sign-in that keeps the session owned by the vendor CLI.',
  'security-audit': 'Read-only scan for secret values that look misplaced. Values never leave this computer.',
};

/** Home for one dedicated CLI: what CLIHarbor adds on top of the generic workspace. */
export function PlatformPage({ platform, tasks, onOpenFeature, onOpenDiagnostics }: PlatformPageProps) {
  const taskCount = tasks.filter((task) => task.packId === platform.packId && task.toolId === platform.toolId).length;
  return (
    <section className="panel platform-page" aria-labelledby="platform-heading">
      <p className="status-label">Dedicated CLI</p>
      <h2 id="platform-heading">{platform.name}</h2>
      <p>{platform.summary}</p>
      <p role="status">
        {platform.ready
          ? <><strong>CLI ready.</strong> Everything below is built and tested for this CLI.</>
          : <><strong>CLI not ready.</strong> Fix setup in Diagnostics, then come back.</>}
      </p>
      {!platform.ready && (
        <button type="button" className="secondary-button" onClick={onOpenDiagnostics}>Open Diagnostics</button>
      )}
      <ul className="platform-features">
        {platform.features.map((feature) => (
          <li key={feature.id}>
            <h3>{feature.name}</h3>
            <p>{featureDetail[feature.id]}{feature.id === 'tasks' ? ` ${taskCount} available.` : ''}</p>
            <button type="button" onClick={() => onOpenFeature(feature.id)}
              disabled={feature.id === 'tasks' && taskCount === 0}>
              Open {feature.name}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

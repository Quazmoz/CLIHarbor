import { useState } from 'react';
import { preparePackDraft, type DraftFields, type DraftPlatform } from './packDraft';

const defaultDraft: DraftFields = {
  packId: '',
  name: '',
  toolId: '',
  executable: '',
  platforms: ['windows'],
};
const allPlatforms: { id: DraftPlatform; label: string }[] = [
  { id: 'windows', label: 'Windows' },
  { id: 'linux', label: 'Linux' },
  { id: 'darwin', label: 'macOS' },
];

interface PackAuthoringWizardProps {
  registeredPackIds: string[];
}

export function PackAuthoringWizard({ registeredPackIds }: PackAuthoringWizardProps) {
  const [expanded, setExpanded] = useState(false);
  const [fields, setFields] = useState<DraftFields>(defaultDraft);
  const [downloaded, setDownloaded] = useState(false);
  const { yaml, issues } = preparePackDraft(fields, registeredPackIds);
  const fileName = fields.packId.trim() + '.yaml';
  const setField = (key: 'packId' | 'name' | 'toolId' | 'executable', value: string) => {
    setFields((current) => ({ ...current, [key]: value }));
    setDownloaded(false);
  };
  const issueFor = (field: keyof DraftFields) => issues.find((issue) => issue.field === field)?.message;
  const download = () => {
    if (yaml === null) return;
    const objectURL = URL.createObjectURL(new Blob([yaml], { type: 'application/yaml;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = objectURL;
    link.download = fileName;
    try {
      link.click();
      setDownloaded(true);
    } finally {
      URL.revokeObjectURL(objectURL);
    }
  };

  return (
    <section className="pack-authoring" aria-labelledby="pack-authoring-heading">
      <div className="pack-authoring-heading">
        <div>
          <p className="status-label">Your own approved tools</p>
          <h3 id="pack-authoring-heading">Create a custom CLI pack</h3>
          <p>Not in the catalog? Generate a discovery-only YAML draft for an approved CLI. No commands are enabled.</p>
        </div>
        <button type="button" className="secondary-button" aria-expanded={expanded}
          aria-controls="pack-authoring-content" onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'Close authoring guide' : 'Start authoring'}
        </button>
      </div>
      {expanded && (
        <div className="pack-authoring-body" id="pack-authoring-content">
          <p className="pack-authoring-boundary">
            This creates a local file only. It does not install software, inspect your device, upload data,
            run commands, or trust or load a pack. An operator must review and explicitly load the resulting file.
          </p>
          <div className="pack-authoring-fields">
            <fieldset>
              <legend>1. Identify the CLI</legend>
              <label htmlFor="draft-pack-id">Pack ID</label>
              <input id="draft-pack-id" autoComplete="off" spellCheck={false} maxLength={63}
                value={fields.packId} placeholder="my-cli" aria-invalid={!!issueFor('packId')}
                onChange={(event) => setField('packId', event.target.value)} />
              {issueFor('packId') && <small role="alert">{issueFor('packId')}</small>}
              <label htmlFor="draft-name">Display name</label>
              <input id="draft-name" maxLength={120} value={fields.name} placeholder="My CLI"
                aria-invalid={!!issueFor('name')} onChange={(event) => setField('name', event.target.value)} />
              {issueFor('name') && <small role="alert">{issueFor('name')}</small>}
              <label htmlFor="draft-tool-id">Tool ID</label>
              <input id="draft-tool-id" autoComplete="off" spellCheck={false} maxLength={63}
                value={fields.toolId} placeholder="my-tool" aria-invalid={!!issueFor('toolId')}
                onChange={(event) => setField('toolId', event.target.value)} />
              {issueFor('toolId') && <small role="alert">{issueFor('toolId')}</small>}
              <label htmlFor="draft-executable">Executable filename (basename only)</label>
              <input id="draft-executable" autoComplete="off" spellCheck={false} maxLength={128}
                value={fields.executable} placeholder="my-tool" aria-invalid={!!issueFor('executable')}
                onChange={(event) => setField('executable', event.target.value)} />
              {issueFor('executable') && <small role="alert">{issueFor('executable')}</small>}
              <p className="pack-authoring-hint">Use an approved, already-installed vendor executable. No paths, URLs, scripts, or credentials.</p>
            </fieldset>
            <fieldset>
              <legend>2. Supported operating systems</legend>
              {allPlatforms.map(({ id, label }) => (
                <label className="pack-platform-option" key={id}>
                  <input type="checkbox" checked={fields.platforms.includes(id)}
                    onChange={(event) => {
                      setFields((current) => ({
                        ...current,
                        platforms: event.target.checked
                          ? [...current.platforms, id]
                          : current.platforms.filter((platform) => platform !== id),
                      }));
                      setDownloaded(false);
                    }} />
                  {label}
                </label>
              ))}
              {issueFor('platforms') && <small role="alert">{issueFor('platforms')}</small>}
              <p className="pack-authoring-hint">Select only operating systems you can verify. Platform selection does not qualify a binary or its version.</p>
            </fieldset>
          </div>
          <div className="pack-authoring-review">
            <h4>3. Review and export</h4>
            {yaml === null ? (
              <p role="status">Complete the required fields above to preview the discovery-only pack.</p>
            ) : (
              <>
                <label htmlFor="draft-yaml-preview">Generated YAML — no runnable tasks</label>
                <textarea id="draft-yaml-preview" value={yaml} readOnly rows={14} spellCheck={false} />
              </>
            )}
            <button type="button" disabled={yaml === null} onClick={download}>Download pack draft (.yaml)</button>
            {downloaded && <p role="status">Draft download started. This file has not been validated, trusted, or loaded.</p>}
          </div>
          <div className="pack-authoring-next">
            <h4>4. Validate and enable intentionally</h4>
            <p>From an approved local copy of CLIHarbor, review the YAML and run these operator commands against the file you downloaded:</p>
            <ol>
              <li><code>cliharbor pack validate ./&lt;pack-id&gt;.yaml</code> — parse and validate without running the CLI.</li>
              <li><code>cliharbor pack lint ./&lt;pack-id&gt;.yaml</code> — check authoring quality and security metadata.</li>
              <li>Add only documented, human-reviewed commands using the <a href="https://github.com/Quazmoz/CLIHarbor/blob/main/docs/PACK_SPEC.md" target="_blank" rel="noreferrer">pack specification</a>, then validate and lint again. No tasks exist until you author them.</li>
              <li><code>cliharbor doctor --pack-file ./&lt;pack-id&gt;.yaml</code> — inspect compatibility and discovery.</li>
              <li><code>cliharbor serve --pack-file ./&lt;pack-id&gt;.yaml</code> — explicitly load the reviewed pack on restart, alongside the built-ins.</li>
            </ol>
            <p>Only the local operator can choose trusted pack sources. CLIHarbor never activates a downloaded draft from this page.</p>
          </div>
        </div>
      )}
    </section>
  );
}

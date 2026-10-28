import { useMemo } from 'react';
import { decodeRunOutput, type RunSnapshot } from './api/runs';
import { runOutcomeHeading } from './operatorLanguage';

const maxPreviewCharacters = 20_000;
const maxPreviewLines = 200;

function preview(text: string) {
  const lines = text === '' ? [] : text.slice(0, maxPreviewCharacters).split('\n', maxPreviewLines + 1);
  return { lines: lines.slice(0, maxPreviewLines), limited: text.length > maxPreviewCharacters || lines.length > maxPreviewLines };
}

function StreamComparison({ name, baseline, selected }: { name: string; baseline: string; selected: string }) {
  const before = preview(baseline);
  const after = preview(selected);
  // ponytail: positional line alignment; use a bounded diff algorithm if insertion-aware alignment is needed.
  return (
    <details className="run-comparison-stream" open={baseline !== selected}>
      <summary>{name} · {baseline === selected ? 'Same text' : 'Text differs'}</summary>
      {(before.limited || after.limited) && <p className="output-limit-note">Comparison preview limited to 200 lines and 20,000 characters per stream. The comparison above uses the full retained text; inspect Raw for complete evidence.</p>}
      <div className="run-comparison-panes">
        {[{ title: 'Baseline', own: before, other: after }, { title: 'Selected', own: after, other: before }].map(({ title, own, other }) => (
          <section key={title} aria-label={title + ' ' + name}>
            <h5>{title} {name}</h5>
            {own.lines.length === 0 ? <p>No {name} retained.</p> : (
              <ol className="run-comparison-lines" aria-label={title + ' ' + name + ' lines'} tabIndex={0}>
                {own.lines.map((line, index) => (
                  <li key={index} className={line === other.lines[index] ? '' : 'run-comparison-line-changed'}>
                    <span className="run-comparison-line-number" aria-label={'Line ' + (index + 1) + (line === other.lines[index] ? ', same' : ', differs')}>
                      {index + 1} {line === other.lines[index] ? '=' : '≠'}
                    </span>
                    <code>{line === '' ? '(empty line)' : line}</code>
                  </li>
                ))}
              </ol>
            )}
          </section>
        ))}
      </div>
    </details>
  );
}

/** Compares already-fetched inert text; never starts work or parses vendor output. */
export function RunComparison({ baseline, selected }: { baseline: RunSnapshot; selected: RunSnapshot }) {
  const compatible = baseline.packId === selected.packId && baseline.commandId === selected.commandId && baseline.toolId === selected.toolId;
  const complete = baseline.status !== 'running' && selected.status !== 'running';
  const streams = useMemo(() => compatible && complete && baseline.runId !== selected.runId
    ? (['stdout.chunk', 'stderr.chunk'] as const).map((stream) => ({
      name: stream === 'stdout.chunk' ? 'stdout' : 'stderr',
      baseline: decodeRunOutput(baseline, stream),
      selected: decodeRunOutput(selected, stream),
    })) : [], [baseline, selected, compatible, complete]);

  return (
    <section className="run-comparison" aria-labelledby="run-comparison-heading">
      <h4 id="run-comparison-heading">Compare recorded runs</h4>
      {!compatible ? <p role="status">Choose a run of {baseline.packId}/{baseline.commandId} using {baseline.toolId} to compare the same task.</p>
        : !complete ? <p role="status">Wait for the selected run to finish before comparing its evidence.</p>
          : baseline.runId === selected.runId ? <p role="status">Baseline pinned. Open another run of this task to compare recorded output.</p>
            : <>
              <div className="run-comparison-panes run-comparison-identities">
                {[{ title: 'Baseline', run: baseline }, { title: 'Selected', run: selected }].map(({ title, run }) => (
                  <div key={title}>
                    <strong>{title} · {runOutcomeHeading(run.status, run.exitCode)}</strong>
                    <code className="run-history-id">{run.runId}</code>
                    <span>{run.toolId} · Version {run.toolVersion ?? 'unavailable'}</span>
                    <span>Started: {run.startedAt ?? 'unavailable'}</span>
                  </div>
                ))}
              </div>
              <p>Lines align by number; inserted lines shift later comparisons. Inputs and vendor context may differ, so matching output does not prove unchanged service state.</p>
              {streams.map((stream) => <StreamComparison key={stream.name} {...stream} />)}
            </>}
    </section>
  );
}

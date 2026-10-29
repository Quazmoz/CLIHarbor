import { useState } from 'react';
import type { Task } from './api/tasks';
import type { ToolDiagnostic } from './api/tools';
import { taskToolKey } from './TaskDiscovery';
import { ToolIcon } from './ToolIcon';

interface ToolExplorerProps {
  tools: ToolDiagnostic[];
  tasks: Task[];
  selectedToolKey: string;
  disabled?: boolean;
  onSelectTool: (toolKey: string) => void;
  onOpenTools: () => void;
}

export function toolStatusLabel(tool: ToolDiagnostic): { label: string; tone: 'ready' | 'setup' | 'unavailable' } {
  if (tool.status === 'ready') return { label: 'Ready', tone: 'ready' };
  if (tool.status === 'missing') return { label: 'Not installed', tone: 'setup' };
  return { label: 'Unavailable', tone: 'unavailable' };
}

export function ToolExplorer({ tools, tasks, selectedToolKey, disabled, onSelectTool, onOpenTools }: ToolExplorerProps) {
  const [expanded, setExpanded] = useState(window.innerWidth >= 1100);
  const taskCount = (tool: ToolDiagnostic) => tasks.filter((task) => taskToolKey(task) === taskToolKey(tool)).length;
  const groups = [
    { id: 'ready', title: 'Ready to use', tools: tools.filter((tool) => tool.status === 'ready') },
    { id: 'attention', title: 'Needs setup', tools: tools.filter((tool) => tool.status !== 'ready') },
  ].filter((group) => group.tools.length > 0);

  return (
    <details className="panel tool-explorer" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary id="tool-explorer-heading">Tool Explorer</summary>
      <div className="tool-explorer-content">
      <div className="tool-explorer-header">
        <span className="overview-muted">Filter approved tasks by CLI</span>
        <button type="button" className="icon-button" aria-label="Add a CLI" title="Add a CLI" onClick={onOpenTools}>
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
        </button>
      </div>
      <button type="button" className="tool-explorer-all" aria-pressed={selectedToolKey === ''} disabled={disabled}
        onClick={() => onSelectTool('')}>
        <span>All tools</span>
        <span className="tool-explorer-count">{tasks.length} task{tasks.length === 1 ? '' : 's'}</span>
      </button>
      {groups.length === 0 && <p className="tool-explorer-empty">No CLIs are configured yet. Use Add a CLI to set one up.</p>}
      {groups.map((group) => (
        <details key={group.id} className="tool-explorer-group" open>
          <summary>
            <span>{group.title}</span>
            <span className="tool-explorer-count">{group.tools.length}</span>
          </summary>
          <ul>
            {group.tools.map((tool) => {
              const key = taskToolKey(tool);
              const count = taskCount(tool);
              const status = toolStatusLabel(tool);
              return (
                <li key={key}>
                  <button type="button" className="tool-explorer-item" disabled={disabled && count > 0}
                    aria-pressed={count > 0 ? selectedToolKey === key : undefined}
                    onClick={() => (count > 0 ? onSelectTool(key) : onOpenTools())}>
                    <ToolIcon tool={tool} />
                    <span className="tool-explorer-copy">
                      <strong title={tool.packName}>{tool.packName}</strong>{' '}
                      <span>
                        {tool.toolId}{tool.version ? ' ' + tool.version : ''} · {count > 0 ? `${count} task${count === 1 ? '' : 's'}` : 'set up in Add a CLI'}
                      </span>{' '}
                    </span>
                    <span className={'tool-badge tool-badge--' + status.tone}>{status.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </details>
      ))}
      </div>
    </details>
  );
}

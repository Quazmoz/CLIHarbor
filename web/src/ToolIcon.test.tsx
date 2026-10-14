import { render } from '@testing-library/react';
import { expect, test } from 'vitest';
import { resolveToolMark, ToolIcon } from './ToolIcon';

const tool = (toolId: string, packId = '', packName = '') => ({ toolId, packId, packName });

test('resolves brand marks from the most specific tool identifier', () => {
  expect(resolveToolMark(tool('gh', 'github-cli', 'GitHub CLI'))?.title).toBe('GitHub');
  expect(resolveToolMark(tool('kubectl', 'kubectl-cli', 'Kubernetes kubectl'))?.title).toBe('Kubernetes');
  expect(resolveToolMark(tool('idsec', 'idira-cyberark-phase0', 'Idira/CyberArk Phase 0 Inventory'))?.title).toBe('Secrets manager');
  // A custom pack wrapping a known CLI under another tool id still gets its mark.
  expect(resolveToolMark(tool('dctl', 'acme-docker-tools', 'Acme'))?.title).toBe('Docker');
  expect(resolveToolMark(tool('fixture', 'example', 'Synthetic Example Pack'))).toBeUndefined();
});

test('falls back to a monogram and picks a legible glyph colour', () => {
  expect(render(<ToolIcon tool={tool('fixture')} />).container.textContent).toBe('fi');
  const vault = render(<ToolIcon tool={tool('vault')} />).container.querySelector('span') as HTMLElement;
  expect(vault.style.color).toBe('rgb(11, 18, 34)');
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { StructuredResultView } from './StructuredResultView';
import type { StructuredField } from './api/runs';

const fields: StructuredField[] = [
  {
    key: 'beta',
    label: 'Beta',
    type: 'string',
    present: true,
    value: '<img id="structured-pwn" src=x onerror="document.body.dataset.pwned=1">',
  },
  {
    key: 'alpha',
    label: 'Alpha',
    type: 'string',
    present: true,
    value: 'alpha-value',
  },
  {
    key: 'missing',
    label: 'Missing',
    type: 'string',
    present: false,
    value: '',
  },
];

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

afterEach(() => {
  if (originalClipboard === undefined) {
    Reflect.deleteProperty(navigator, 'clipboard');
  } else {
    Object.defineProperty(navigator, 'clipboard', originalClipboard);
  }
  vi.restoreAllMocks();
});

describe('StructuredResultView', () => {
  test('filters and sorts validated fields while keeping hostile values inert', () => {
    const { container } = render(<StructuredResultView fields={fields} />);

    expect(screen.getByText(fields[0].value)).toBeInTheDocument();
    expect(document.querySelector('#structured-pwn')).toBeNull();
    expect(document.body.dataset.pwned).toBeUndefined();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter fields' }), {
      target: { value: 'alpha-value' },
    });
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.queryByText('Beta')).not.toBeInTheDocument();
    expect(screen.getByText('1 of 3')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter fields' }), {
      target: { value: '' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort fields' }), {
      target: { value: 'label' },
    });

    const labels = Array.from(container.querySelectorAll('.structured-card dt')).map(
      (element) => element.textContent,
    );
    expect(labels).toEqual(['Alpha', 'Beta', 'Missing']);
  });

  test('copies only the explicitly selected present field value', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(<StructuredResultView fields={fields} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy Alpha value' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('alpha-value'));
    expect(await screen.findByText('Copied Alpha.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy Missing value' })).toBeDisabled();
  });

  test('shows a normalized JSON inspection view without adding raw process output', () => {
    render(<StructuredResultView fields={fields} />);

    const details = screen.getByText('Normalized JSON view').closest('details');
    expect(details).not.toBeNull();
    expect(details).toHaveTextContent('"key": "alpha"');
    expect(details).toHaveTextContent('"value": null');
    expect(details).toHaveTextContent(/raw stdout and stderr are not added here/i);
  });
});

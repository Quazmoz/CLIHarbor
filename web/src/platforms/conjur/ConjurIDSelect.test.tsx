import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { ConjurIDSelect } from './ConjurIDSelect';
import { RoleOptions } from './conjurRuns';

test('manual entry receives focus and validation errors belong to the editable input', () => {
  const props = { label: 'Variable', value: '', options: ['apps/password'], onChange: vi.fn() };
  const view = render(<ConjurIDSelect {...props} />);
  fireEvent.change(screen.getByRole('combobox', { name: 'Variable' }), { target: { value: 'manual' } });
  expect(screen.getByRole('textbox', { name: 'Variable — enter ID' })).toHaveFocus();
  view.rerender(<ConjurIDSelect {...props} error="Enter a valid variable ID" />);
  expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByRole('combobox')).not.toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByRole('textbox')).toHaveAccessibleDescription('Enter a valid variable ID');
});

test('real IDs cannot collide with manual-entry option values', () => {
  const onChange = vi.fn();
  render(<ConjurIDSelect label="Variable" value="manual" options={['manual', 'value:manual']} onChange={onChange} />);
  const select = screen.getByRole('combobox');
  expect(select).toHaveValue('value:manual');
  fireEvent.change(select, { target: { value: 'value:value:manual' } });
  expect(onChange).toHaveBeenLastCalledWith('value:manual');
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
});

test('a selected role stays visible while inventory is unavailable or no longer lists it', () => {
  const choice = (inventory: { group: string[] } | null) => <label>Owner<select value="group:operators" onChange={vi.fn()}>
    <option value="">Parent policy</option><RoleOptions inventory={inventory} kinds={['group']} selected="group:operators" />
  </select></label>;
  const view = render(choice({ group: ['operators'] }));
  expect(screen.getByRole('combobox')).toHaveValue('group:operators');
  view.rerender(choice(null));
  expect(screen.getByRole('combobox')).toHaveValue('group:operators');
  expect(screen.getByRole('option', { selected: true })).toHaveTextContent('group:operators (not currently listed)');
  view.rerender(choice({ group: ['other-role'] }));
  expect(screen.getByRole('combobox')).toHaveValue('group:operators');
});

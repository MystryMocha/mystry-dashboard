// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { Field, FormFeedbackProvider, focusFirstInvalidField, useFormFeedback } from '../src/components/Field';
import { NumberInput, cleanNumberText } from '../src/components/NumberInput';
import { PasswordInput } from '../src/components/PasswordInput';
import { ChangePasswordDialog } from '../src/components/ChangePasswordDialog';
import { setupFormTestEnv } from './form-test-env';

beforeEach(setupFormTestEnv);

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** One required field with a minimum of 3 characters, plus an unrelated field used to move focus away. */
function Sample() {
  const [name, setName] = useState('');
  const feedback = useFormFeedback();
  const root = useRef<HTMLDivElement>(null);
  const error = name !== '' && name.length < 3 ? '至少 3 个字符' : null;
  return (
    <FormFeedbackProvider value={feedback.value}>
      <div ref={root}>
        <Field label="别名" optional>{(control) => <input {...control} />}</Field>
        <Field label="名称" help="会显示在列表里" error={error}>
          {(control) => <input {...control} value={name} onChange={(event) => setName(event.target.value)} />}
        </Field>
        <button type="button" onClick={() => { feedback.revealAll(); focusFirstInvalidField(root.current); }}>检查</button>
        <button type="button" onClick={() => { setName(''); feedback.reset(); }}>放弃</button>
        <button type="button" onClick={() => setName('ab')}>填错</button>
      </div>
    </FormFeedbackProvider>
  );
}

test('field: the error shows only after blur, disappears once fixed, and is associated with the input', async () => {
  const user = userEvent.setup();
  render(<Sample />);
  const input = screen.getByLabelText('名称');
  expect(screen.getByLabelText('别名（可选）')).toBeTruthy();
  // The description is always associated with the input.
  expect(document.getElementById(input.getAttribute('aria-describedby')!)!.textContent).toBe('会显示在列表里');

  await user.type(input, 'ab');
  // Still typing: no interruption.
  expect(screen.queryByText('至少 3 个字符')).toBeNull();
  expect(input.getAttribute('aria-invalid')).toBeNull();

  await user.tab();
  const error = screen.getByText('至少 3 个字符');
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(input.getAttribute('aria-describedby')!.split(' ')).toContain(error.id);

  // A field already showing an error is rechecked on every keystroke.
  await user.type(input, 'c');
  expect(screen.queryByText('至少 3 个字符')).toBeNull();
  expect(input.getAttribute('aria-invalid')).toBeNull();
});

test('field: when asked to show everything it jumps to the first failing field, and returns to untouched after a reset', async () => {
  const user = userEvent.setup();
  render(<Sample />);
  const input = screen.getByLabelText('名称');
  // An empty required item is not marked red, and no field to jump to is found.
  await user.click(screen.getByRole('button', { name: '检查' }));
  expect(input.getAttribute('aria-invalid')).toBeNull();

  await user.click(screen.getByRole('button', { name: '放弃' }));
  await user.click(screen.getByRole('button', { name: '填错' }));
  // Never blurred and not asked to show: nothing is reported.
  expect(screen.queryByText('至少 3 个字符')).toBeNull();
  await user.click(screen.getByRole('button', { name: '检查' }));
  expect(screen.getByText('至少 3 个字符')).toBeTruthy();
  expect(document.activeElement).toBe(input);

  await user.click(screen.getByRole('button', { name: '放弃' }));
  await user.click(screen.getByRole('button', { name: '填错' }));
  expect(screen.queryByText('至少 3 个字符')).toBeNull();
});

test('number text: tidies full-width characters, thousands separators and stray characters, keeping unfinished intermediate states', () => {
  expect(cleanNumberText(' 1,024 ')).toBe('1024');
  expect(cleanNumberText('１２３４')).toBe('1234');
  expect(cleanNumberText('12e3+')).toBe('123');
  expect(cleanNumberText('-5')).toBe('5');
  expect(cleanNumberText('-5', { allowNegative: true })).toBe('-5');
  expect(cleanNumberText('-', { allowNegative: true })).toBe('-');
  expect(cleanNumberText('5-1', { allowNegative: true })).toBe('51');
  expect(cleanNumberText('4.', { decimal: true })).toBe('4.');
  expect(cleanNumberText('2.4.4', { decimal: true })).toBe('2.44');
  expect(cleanNumberText('2.5')).toBe('25');
  expect(cleanNumberText('')).toBe('');
});

test('number box: a text box with a numeric keyboard that can be cleared, and a dirty value passed in is shown as is', async () => {
  const user = userEvent.setup();
  const seen: string[] = [];
  function Host({ initial }: { initial: string }) {
    const [value, setValue] = useState(initial);
    return <label>内存<NumberInput value={value} suffix="GB" onChange={(text) => { seen.push(text); setValue(text); }} /></label>;
  }
  const first = render(<Host initial="abc" />);
  const dirty = screen.getByRole('textbox') as HTMLInputElement;
  expect(dirty.value).toBe('abc');
  expect(seen).toEqual([]);
  first.unmount();

  render(<Host initial="7680" />);
  const input = screen.getByRole('textbox') as HTMLInputElement;
  expect(input.type).toBe('text');
  expect(input.inputMode).toBe('numeric');
  // The unit is read out to screen readers through aria-describedby.
  expect(document.getElementById(input.getAttribute('aria-describedby')!)!.textContent).toBe('GB');
  await user.clear(input);
  expect(input.value).toBe('');
  expect(seen.at(-1)).toBe('');
  await user.type(input, '4x0e96');
  expect(input.value).toBe('4096');
  await user.clear(input);
  await user.paste(' 12,288 ');
  expect(input.value).toBe('12288');
});

test('password box: hidden by default, the button shows and hides it, and the button is disabled too when the box is disabled', async () => {
  const user = userEvent.setup();
  const view = render(<label>密码<PasswordInput defaultValue="secret-value" /></label>);
  const input = view.container.querySelector('input')!;
  expect(input.type).toBe('password');
  await user.click(screen.getByRole('button', { name: '显示密码' }));
  expect(input.type).toBe('text');
  const hide = screen.getByRole('button', { name: '隐藏密码' });
  expect(hide.getAttribute('aria-pressed')).toBe('true');
  expect(hide.getAttribute('type')).toBe('button');
  await user.click(hide);
  expect(input.type).toBe('password');
  view.unmount();
  render(<label>密码<PasswordInput disabled /></label>);
  expect((screen.getByRole('button', { name: '显示密码' }) as HTMLButtonElement).disabled).toBe(true);
});

test('change password: the new password is entered only once, a too-short one is explained after blur, and Enter jumps back to it', async () => {
  const user = userEvent.setup();
  render(<ChangePasswordDialog onClose={() => {}} />);
  expect(screen.queryByLabelText('确认新密码')).toBeNull();
  const next = screen.getByLabelText('新密码');
  const current = screen.getByLabelText('当前密码');
  await user.type(current, 'old-password-value');
  await user.type(next, 'short');
  expect(next.getAttribute('aria-invalid')).toBeNull();
  await user.tab();
  expect(next.getAttribute('aria-invalid')).toBe('true');
  const describedBy = next.getAttribute('aria-describedby')!.split(' ').map((id) => document.getElementById(id)!.textContent ?? '');
  // The error is about the length itself, so the original description is not repeated.
  expect(describedBy).toEqual(['密码至少 12 个字符']);
  // Pressing Enter while focus is elsewhere: it cannot submit, and goes back to the field to fix.
  current.focus();
  await user.keyboard('{Enter}');
  expect(document.activeElement).toBe(next);
});

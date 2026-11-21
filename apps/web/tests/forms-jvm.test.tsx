// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { JvmSettingsEditor } from '../src/components/JvmSettingsEditor';
import { setupFormTestEnv } from './form-test-env';

/** Memory reported by the local node (MiB); null means host info cannot be read. */
let totalMemMb: number | null;
let emitted: string[];
let validity: boolean[];

beforeEach(() => {
  setupFormTestEnv();
  totalMemMb = 32000;
  emitted = [];
  validity = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const data = url === '/api/nodes'
      ? [{ id: 'local', name: 'local', isLocal: true, hostInfo: totalMemMb === null ? null : { totalMemMb } }]
      : {};
    return new Response(JSON.stringify(data));
  }));
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** Like the four entry pages: the parent stores the jvmArgs string itself, and this also records each emitted value and its validity. */
function Host({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  return (
    <JvmSettingsEditor
      value={value}
      onChange={(next) => { emitted.push(next); setValue(next); }}
      coreType="paper"
      javaMajor={21}
      onValidityChange={(valid) => { validity.push(valid); }}
    />
  );
}

/** Renders and waits for host memory to be read back (presets are filtered by it). */
async function open(initial: string) {
  render(<Host initial={initial} />);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  // Let the several layers of Promises after fetch all settle before host memory counts as read back.
  await act(() => new Promise((resolve) => { setTimeout(resolve, 0); }));
  return {
    max: screen.getByLabelText('最大内存') as HTMLInputElement,
    initial: screen.getByLabelText('初始内存') as HTMLInputElement,
    tiers: screen.queryByRole('group', { name: '常用最大内存' }),
  };
}

const tierNames = (tiers: HTMLElement | null) => (tiers ? within(tiers).getAllByRole('button').map((button) => button.textContent) : []);

test('memory: entered in GB, the emitted jvmArgs are still in MiB, and decimals are allowed', async () => {
  const user = userEvent.setup();
  const { max } = await open('-Xms1024M -Xmx2048M');
  // Neither memory box is type="number" anymore.
  expect(screen.queryByRole('spinbutton')).toBeNull();
  expect(max.type).toBe('text');
  expect(max.inputMode).toBe('decimal');
  expect(max.value).toBe('2');
  // The unit is read out to screen readers; "This computer has … in total" is no longer written.
  const described = max.getAttribute('aria-describedby')!.split(' ').map((id) => document.getElementById(id)!.textContent);
  expect(described).toEqual(['GB']);
  expect(screen.queryByText(/这台电脑共/)).toBeNull();

  await user.clear(max);
  await user.type(max, '6');
  expect(emitted.at(-1)).toBe('-Xms1024M -Xmx6144M');
  const preview = screen.getByLabelText('最终 JVM 参数');
  expect(within(preview).getByText('-Xmx6144M')).toBeTruthy();

  await user.clear(max);
  await user.type(max, '1.5');
  expect(max.value).toBe('1.5');
  expect(emitted.at(-1)).toBe('-Xms1024M -Xmx1536M');
  // An unfinished intermediate state such as "1." is not rewritten to "1".
  expect(emitted).not.toContain('-Xms1024M -Xmx15360M');
  expect(validity.at(-1)).toBe(true);
});

test('memory: can be cleared without snapping back to the original number; the reason shows only after blur, and no invalid value is emitted meanwhile', async () => {
  const user = userEvent.setup();
  const { max } = await open('-Xms1024M -Xmx4096M');
  expect(max.value).toBe('4');

  await user.clear(max);
  expect(max.value).toBe('');
  expect(emitted).toEqual([]);
  expect(validity.at(-1)).toBe(false);
  // Still in this box: no interruption.
  expect(screen.queryByText('请填写内存大小，单位是 GB。')).toBeNull();
  expect(max.getAttribute('aria-invalid')).toBeNull();
  // "Final arguments" is still the previous valid value.
  expect(within(screen.getByLabelText('最终 JVM 参数')).getByText('-Xmx4096M')).toBeTruthy();

  await user.tab();
  const error = screen.getByText('请填写内存大小，单位是 GB。');
  expect(max.value).toBe('');
  expect(max.getAttribute('aria-invalid')).toBe('true');
  expect(max.getAttribute('aria-describedby')!.split(' ')).toContain(error.id);
  expect(max.closest('.field')!.hasAttribute('data-field-invalid')).toBe(true);

  // Below the lower bound: switches to the corresponding reason, and still nothing is emitted.
  await user.type(max, '0.2');
  expect(screen.getByText('内存不能小于 0.5 GB。')).toBeTruthy();
  expect(emitted).toEqual([]);

  // The error disappears as soon as it is fixed.
  await user.clear(max);
  await user.type(max, '8');
  expect(screen.queryByText(/内存不能小于|请填写内存大小/)).toBeNull();
  expect(max.getAttribute('aria-invalid')).toBeNull();
  expect(emitted.at(-1)).toBe('-Xms1024M -Xmx8192M');
  expect(validity.at(-1)).toBe(true);
});

test('memory: an old value that is not a whole GB shows two decimals and is kept as is when untouched', async () => {
  const user = userEvent.setup();
  const { max } = await open('-Xms1024M -Xmx2500M');
  expect(max.value).toBe('2.44');

  // Click in and leave: nothing is emitted when unchanged, and it does not count as invalid.
  await user.click(max);
  await user.tab();
  expect(emitted).toEqual([]);
  expect(validity).not.toContain(false);
  expect(max.value).toBe('2.44');

  // When changing other items the original 2500M is still used, not 2.44 × 1024; under G1 Balanced the initial memory follows it.
  await user.selectOptions(screen.getByLabelText('优化方案'), 'g1-balanced');
  expect(emitted.at(-1)).toContain('-Xmx2500M');
  expect(emitted.at(-1)).toContain('-Xms2500M');

  // Deleting and typing the same number back still gives 2500M.
  await user.clear(max);
  await user.type(max, '2.44');
  expect(max.value).toBe('2.44');
  expect(emitted.at(-1)).toContain('-Xmx2500M');
  expect(emitted.some((value) => value.includes('-Xmx2499M'))).toBe(false);
});

test('memory: the arrows in the box and the ↑ ↓ keys step by 1 GB to the adjacent whole GB, not below 0.5 GB', async () => {
  const user = userEvent.setup();
  const { max } = await open('-Xms1024M -Xmx2500M');
  const up = screen.getByRole('button', { name: '最大内存加 1 GB' });
  const down = screen.getByRole('button', { name: '最大内存减 1 GB' });
  // Like the native arrows it stays out of the Tab order, and cannot be a submit button.
  expect(up.getAttribute('type')).toBe('button');
  expect(up.tabIndex).toBe(-1);

  // Down from 2.44 is 2; clicking the arrow does not take focus from the input.
  await user.click(max);
  await user.click(down);
  expect(max.value).toBe('2');
  expect(emitted.at(-1)).toBe('-Xms1024M -Xmx2048M');
  expect(document.activeElement).toBe(max);

  // Keyboard ↑ twice goes to 4.
  await user.keyboard('{ArrowUp}{ArrowUp}');
  expect(max.value).toBe('4');
  expect(emitted.at(-1)).toBe('-Xms1024M -Xmx4096M');
  // The wheel does not change the number.
  fireEvent.wheel(max, { deltaY: -100 });
  expect(max.value).toBe('4');

  // Down from 1 goes to the lower bound 0.5, and does not move further down.
  await user.clear(max);
  await user.type(max, '1');
  await user.keyboard('{ArrowDown}');
  expect(max.value).toBe('0.5');
  // Under Compatibility First the initial memory is the smaller of 1 GB and max memory.
  expect(emitted.at(-1)).toBe('-Xms512M -Xmx512M');
  const count = emitted.length;
  await user.click(down);
  expect(max.value).toBe('0.5');
  expect(emitted.length).toBe(count);

  // Clicking an arrow after clearing: computed from the previous valid value, and the error disappears with it.
  await user.clear(max);
  await user.tab();
  expect(screen.getByText('请填写内存大小，单位是 GB。')).toBeTruthy();
  await user.click(up);
  expect(max.value).toBe('1');
  expect(screen.queryByText('请填写内存大小，单位是 GB。')).toBeNull();
  expect(validity.at(-1)).toBe(true);
});

test('memory: the arrows still step when an old value is only a few MiB off a whole GB (4100M shows 4)', async () => {
  const user = userEvent.setup();
  const { max } = await open('-Xms1024M -Xmx4100M');
  expect(max.value).toBe('4');
  await user.click(screen.getByRole('button', { name: '最大内存减 1 GB' }));
  expect(max.value).toBe('3');
  expect(emitted.at(-1)).toBe('-Xms1024M -Xmx3072M');
  cleanup();

  const again = await open('-Xms1024M -Xmx4100M');
  await user.click(screen.getByRole('button', { name: '最大内存加 1 GB' }));
  expect(again.max.value).toBe('5');
  expect(emitted.at(-1)).toBe('-Xms1024M -Xmx5120M');
});

test('initial memory: stepping with the arrows counts as setting it manually; the arrows cannot be clicked either while locked by Paper Aikar', async () => {
  const user = userEvent.setup();
  const { initial } = await open('-Xms1024M -Xmx8192M');
  await user.click(screen.getByRole('button', { name: '初始内存加 1 GB' }));
  expect(initial.value).toBe('2');
  expect(emitted.at(-1)).toBe('-Xms2048M -Xmx8192M');
  // Once set manually, changing max memory no longer carries it along.
  await user.click(screen.getByRole('button', { name: '最大内存加 1 GB' }));
  expect(emitted.at(-1)).toBe('-Xms2048M -Xmx9216M');

  await user.selectOptions(screen.getByLabelText('优化方案'), 'paper-aikar');
  expect(initial.disabled).toBe(true);
  for (const name of ['初始内存加 1 GB', '初始内存减 1 GB']) {
    expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
  }
  // Max memory can be stepped up and down as usual, and initial memory follows.
  await user.click(screen.getByRole('button', { name: '最大内存减 1 GB' }));
  expect(emitted.at(-1)).toMatch(/^-Xms8192M -Xmx8192M /);
});

test('memory: max memory offers only the three presets 8 / 10 / 12 GB, and clicking a preset fills it in directly', async () => {
  const user = userEvent.setup();
  const { max, tiers } = await open('-Xms1024M -Xmx2048M');
  expect(tierNames(tiers)).toEqual(['8 GB', '10 GB', '12 GB']);
  // The current 2 GB is not among the presets, so no preset counts as selected; "Recommended" is no longer marked either.
  expect(within(tiers!).getAllByRole('button').some((button) => button.getAttribute('aria-pressed') === 'true')).toBe(false);
  const eight = within(tiers!).getByRole('button', { name: '8 GB' });
  // Presets cannot be submit buttons, or one click inside a <form> would submit.
  expect(eight.getAttribute('type')).toBe('button');

  await user.click(eight);
  expect(max.value).toBe('8');
  expect(emitted.at(-1)).toBe('-Xms1024M -Xmx8192M');
  expect(eight.getAttribute('aria-pressed')).toBe('true');

  // Clicking a preset while the box is filled in wrong: it switches straight to that preset and the error disappears.
  await user.clear(max);
  await user.tab();
  const error = screen.getByText('请填写内存大小，单位是 GB。');
  // The error row must come after the presets: if it came before, it would push the presets down the moment it appears and the click in progress would miss (jsdom has no layout, so only the order can be checked).
  expect(tiers!.compareDocumentPosition(error) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await user.click(within(tiers!).getByRole('button', { name: '10 GB' }));
  expect(max.value).toBe('10');
  expect(screen.queryByText('请填写内存大小，单位是 GB。')).toBeNull();
  expect(emitted.at(-1)).toBe('-Xms1024M -Xmx10240M');
  expect(validity.at(-1)).toBe(true);
});

test('memory: presets are filtered by host memory; all three are offered when host memory cannot be read', async () => {
  const initialTiers = () => tierNames(screen.queryByRole('group', { name: '常用初始内存' }));
  totalMemMb = 8192;
  const small = await open('-Xms1024M -Xmx2048M');
  expect(tierNames(small.tiers)).toEqual(['8 GB']);
  expect(initialTiers()).toEqual(['2 GB', '4 GB', '6 GB']);
  cleanup();

  totalMemMb = 4096;
  const tiny = await open('-Xms1024M -Xmx2048M');
  // When not even one preset fits, the whole group is not shown, rather than leaving an empty button group.
  expect(tiny.tiers).toBeNull();
  expect(initialTiers()).toEqual(['2 GB', '4 GB']);
  cleanup();

  totalMemMb = null;
  const unknown = await open('-Xms1024M -Xmx2048M');
  expect(tierNames(unknown.tiers)).toEqual(['8 GB', '10 GB', '12 GB']);
  expect(initialTiers()).toEqual(['2 GB', '4 GB', '6 GB']);
});

test('initial memory: the three presets 2 / 4 / 6 GB below count as setting it manually when clicked, and it no longer follows max memory afterwards', async () => {
  const user = userEvent.setup();
  const { initial } = await open('-Xms1024M -Xmx8192M');
  const initialGroup = screen.getByRole('group', { name: '常用初始内存' });
  const four = within(initialGroup).getByRole('button', { name: '4 GB' });
  expect(four.getAttribute('type')).toBe('button');
  expect(within(initialGroup).getAllByRole('button').some((button) => button.getAttribute('aria-pressed') === 'true')).toBe(false);

  await user.click(four);
  expect(initial.value).toBe('4');
  expect(emitted.at(-1)).toBe('-Xms4096M -Xmx8192M');
  expect(four.getAttribute('aria-pressed')).toBe('true');

  await user.click(within(screen.getByRole('group', { name: '常用最大内存' })).getByRole('button', { name: '12 GB' }));
  expect(emitted.at(-1)).toBe('-Xms4096M -Xmx12288M');

  // A value larger than max memory is still filled in, and the diagnostic below explains why it cannot be saved.
  await user.click(within(screen.getByRole('group', { name: '常用最大内存' })).getByRole('button', { name: '8 GB' }));
  await user.clear(screen.getByLabelText('最大内存'));
  await user.type(screen.getByLabelText('最大内存'), '3');
  expect(emitted.at(-1)).toBe('-Xms4096M -Xmx3072M');
  expect(screen.getByText('初始内存不能大于最大内存')).toBeTruthy();
  expect(validity.at(-1)).toBe(false);
});

test('initial memory: entered directly in the basic area, it follows max memory while untouched and stops following once changed', async () => {
  const user = userEvent.setup();
  const { max, initial } = await open('-Xms1024M -Xmx4096M');
  expect(initial.type).toBe('text');
  expect(initial.disabled).toBe(false);
  expect(initial.value).toBe('1');
  // The advanced section no longer has "set initial memory manually", and initial memory is not hidden in the collapsible section either.
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(initial.closest('details')).toBeNull();

  // Compatibility First: initial memory is 1 GB when untouched.
  await user.clear(max);
  await user.type(max, '6');
  expect(emitted.at(-1)).toBe('-Xms1024M -Xmx6144M');

  await user.clear(initial);
  expect(initial.value).toBe('');
  expect(validity.at(-1)).toBe(false);
  await user.tab();
  expect(screen.getByText('请填写内存大小，单位是 GB。')).toBeTruthy();
  await user.click(initial);
  await user.type(initial, '2');
  expect(emitted.at(-1)).toBe('-Xms2048M -Xmx6144M');
  expect(validity.at(-1)).toBe(true);

  // After initial memory is changed, changing max memory does not change initial memory with it.
  await user.click(within(screen.getByRole('group', { name: '常用最大内存' })).getByRole('button', { name: '8 GB' }));
  expect(emitted.at(-1)).toBe('-Xms2048M -Xmx8192M');
  expect(initial.value).toBe('2');
});

test('G1 Balanced: switching to it makes initial memory equal max memory automatically and follow it afterwards; switching back to Compatibility First returns to 1 GB', async () => {
  const user = userEvent.setup();
  const { max, initial } = await open('-Xms1024M -Xmx4096M');
  // Even after initial memory was changed manually, switching to G1 still sets it equal to max memory.
  await user.clear(initial);
  await user.type(initial, '2');
  expect(emitted.at(-1)).toBe('-Xms2048M -Xmx4096M');

  await user.selectOptions(screen.getByLabelText('优化方案'), 'g1-balanced');
  expect(emitted.at(-1)).toMatch(/^-Xms4096M -Xmx4096M -XX:\+UseG1GC /);
  expect(initial.value).toBe('4');
  expect(screen.getByText('G1 均衡下和最大内存相同。')).toBeTruthy();

  await user.click(within(screen.getByRole('group', { name: '常用最大内存' })).getByRole('button', { name: '12 GB' }));
  expect(emitted.at(-1)).toMatch(/^-Xms12288M -Xmx12288M /);
  expect(initial.value).toBe('12');

  // Initial memory can be changed under G1 too, and the explanation goes away once it is changed.
  await user.clear(initial);
  await user.type(initial, '4');
  expect(emitted.at(-1)).toMatch(/^-Xms4096M -Xmx12288M /);
  expect(screen.queryByText('G1 均衡下和最大内存相同。')).toBeNull();

  // Switching back to Compatibility First leaves what the user changed alone; switching to G1 aligns again, and then switching back to Compatibility First gives 1 GB.
  await user.selectOptions(screen.getByLabelText('优化方案'), 'compatibility');
  expect(emitted.at(-1)).toBe('-Xms4096M -Xmx12288M');
  await user.selectOptions(screen.getByLabelText('优化方案'), 'g1-balanced');
  await user.selectOptions(screen.getByLabelText('优化方案'), 'compatibility');
  expect(emitted.at(-1)).toBe('-Xms1024M -Xmx12288M');
  expect(max.value).toBe('12');
});

test('Paper Aikar: initial memory is locked to equal max memory, with the reason explained', async () => {
  const user = userEvent.setup();
  const { initial } = await open('-Xms1024M -Xmx6144M');
  await user.selectOptions(screen.getByLabelText('优化方案'), 'paper-aikar');
  expect(emitted.at(-1)).toMatch(/^-Xms6144M -Xmx6144M /);
  expect(initial.disabled).toBe(true);
  expect(initial.value).toBe('6');
  // While locked, the initial memory presets cannot be clicked either.
  for (const button of within(screen.getByRole('group', { name: '常用初始内存' })).getAllByRole('button')) {
    expect((button as HTMLButtonElement).disabled).toBe(true);
  }
  expect(screen.getByText('Paper Aikar 要求和最大内存相同。')).toBeTruthy();
  expect(initial.getAttribute('aria-describedby')!.split(' ').map((id) => document.getElementById(id)!.textContent))
    .toContain('Paper Aikar 要求和最大内存相同。');
});

test('a saved G1 instance with different initial and max memory: shown as is on open without emitting, and changing max memory does not touch initial memory', async () => {
  const user = userEvent.setup();
  const saved = '-Xms1024M -Xmx4096M -XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200';
  const { max, initial } = await open(saved);
  expect(emitted).toEqual([]);
  expect((screen.getByLabelText('优化方案') as HTMLSelectElement).value).toBe('g1-balanced');
  expect(initial.value).toBe('1');
  expect(max.value).toBe('4');
  expect(screen.queryByText('G1 均衡下和最大内存相同。')).toBeNull();

  await user.clear(max);
  await user.type(max, '6');
  expect(emitted.at(-1)).toMatch(/^-Xms1024M -Xmx6144M /);
});


// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { JvmSettingsEditor } from '../src/components/JvmSettingsEditor';
import { setupFormTestEnv } from './form-test-env';

/** 本机节点上报的内存（MiB）；null 表示读不到主机信息。 */
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

/** 和四个入口页一样：上层自己存 jvmArgs 字符串，这里顺便记下每次外发的值和合法性。 */
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

/** 渲染并等主机内存读回来（档位按它过滤）。 */
async function open(initial: string) {
  render(<Host initial={initial} />);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  // 让 fetch 之后的几层 Promise 都走完，主机内存才算读回来。
  await act(() => new Promise((resolve) => { setTimeout(resolve, 0); }));
  return {
    max: screen.getByLabelText('最大内存') as HTMLInputElement,
    initial: screen.getByLabelText('初始内存') as HTMLInputElement,
    tiers: screen.queryByRole('group', { name: '常用最大内存' }),
  };
}

const tierNames = (tiers: HTMLElement | null) => (tiers ? within(tiers).getAllByRole('button').map((button) => button.textContent) : []);

test('内存：按 GB 填，发出的仍是 MiB 的 jvmArgs，小数也能填', async () => {
  const user = userEvent.setup();
  const { max } = await open('-Xms1024M -Xmx2048M');
  // 两个内存框都不再是 type="number"。
  expect(screen.queryByRole('spinbutton')).toBeNull();
  expect(max.type).toBe('text');
  expect(max.inputMode).toBe('decimal');
  expect(max.value).toBe('2');
  // 单位读给读屏；不再写「这台电脑共……」。
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
  // 「1.」这种没输完的中间状态不会被改写成「1」。
  expect(emitted).not.toContain('-Xms1024M -Xmx15360M');
  expect(validity.at(-1)).toBe(true);
});

test('内存：能删空，不弹回原数字；失焦后才说原因，这期间不外发非法值', async () => {
  const user = userEvent.setup();
  const { max } = await open('-Xms1024M -Xmx4096M');
  expect(max.value).toBe('4');

  await user.clear(max);
  expect(max.value).toBe('');
  expect(emitted).toEqual([]);
  expect(validity.at(-1)).toBe(false);
  // 还在这个框里：不打断。
  expect(screen.queryByText('请填写内存大小，单位是 GB。')).toBeNull();
  expect(max.getAttribute('aria-invalid')).toBeNull();
  // 「最终参数」还是上一个合法值。
  expect(within(screen.getByLabelText('最终 JVM 参数')).getByText('-Xmx4096M')).toBeTruthy();

  await user.tab();
  const error = screen.getByText('请填写内存大小，单位是 GB。');
  expect(max.value).toBe('');
  expect(max.getAttribute('aria-invalid')).toBe('true');
  expect(max.getAttribute('aria-describedby')!.split(' ')).toContain(error.id);
  expect(max.closest('.field')!.hasAttribute('data-field-invalid')).toBe(true);

  // 小于下限：换成对应的原因，仍然不外发。
  await user.type(max, '0.2');
  expect(screen.getByText('内存不能小于 0.5 GB。')).toBeTruthy();
  expect(emitted).toEqual([]);

  // 改对了错误马上消失。
  await user.clear(max);
  await user.type(max, '8');
  expect(screen.queryByText(/内存不能小于|请填写内存大小/)).toBeNull();
  expect(max.getAttribute('aria-invalid')).toBeNull();
  expect(emitted.at(-1)).toBe('-Xms1024M -Xmx8192M');
  expect(validity.at(-1)).toBe(true);
});

test('内存：不是整数 GB 的旧值显示两位小数，不动它就原样保留', async () => {
  const user = userEvent.setup();
  const { max } = await open('-Xms1024M -Xmx2500M');
  expect(max.value).toBe('2.44');

  // 点进去再离开：没改就不外发，也不算不合法。
  await user.click(max);
  await user.tab();
  expect(emitted).toEqual([]);
  expect(validity).not.toContain(false);
  expect(max.value).toBe('2.44');

  // 改别的项时用的还是原来的 2500M，不是 2.44 × 1024；G1 均衡下初始内存跟着它。
  await user.selectOptions(screen.getByLabelText('优化方案'), 'g1-balanced');
  expect(emitted.at(-1)).toContain('-Xmx2500M');
  expect(emitted.at(-1)).toContain('-Xms2500M');

  // 删掉又填回同一个数，也还是 2500M。
  await user.clear(max);
  await user.type(max, '2.44');
  expect(max.value).toBe('2.44');
  expect(emitted.at(-1)).toContain('-Xmx2500M');
  expect(emitted.some((value) => value.includes('-Xmx2499M'))).toBe(false);
});

test('内存：框里的上下箭头和 ↑ ↓ 键按 1 GB 加减，走到相邻的整数 GB，不低于 0.5 GB', async () => {
  const user = userEvent.setup();
  const { max } = await open('-Xms1024M -Xmx2500M');
  const up = screen.getByRole('button', { name: '最大内存加 1 GB' });
  const down = screen.getByRole('button', { name: '最大内存减 1 GB' });
  // 和原生箭头一样不进 Tab 顺序，也不能是提交按钮。
  expect(up.getAttribute('type')).toBe('button');
  expect(up.tabIndex).toBe(-1);

  // 2.44 往下是 2；点箭头不抢输入框的焦点。
  await user.click(max);
  await user.click(down);
  expect(max.value).toBe('2');
  expect(emitted.at(-1)).toBe('-Xms1024M -Xmx2048M');
  expect(document.activeElement).toBe(max);

  // 键盘 ↑ 两下到 4。
  await user.keyboard('{ArrowUp}{ArrowUp}');
  expect(max.value).toBe('4');
  expect(emitted.at(-1)).toBe('-Xms1024M -Xmx4096M');
  // 滚轮不改数字。
  fireEvent.wheel(max, { deltaY: -100 });
  expect(max.value).toBe('4');

  // 1 往下到下限 0.5，再往下不动。
  await user.clear(max);
  await user.type(max, '1');
  await user.keyboard('{ArrowDown}');
  expect(max.value).toBe('0.5');
  // 兼容优先下初始内存取 1 GB 和最大内存中小的那个。
  expect(emitted.at(-1)).toBe('-Xms512M -Xmx512M');
  const count = emitted.length;
  await user.click(down);
  expect(max.value).toBe('0.5');
  expect(emitted.length).toBe(count);

  // 删空后点箭头：从上一个合法值算，错误随之消失。
  await user.clear(max);
  await user.tab();
  expect(screen.getByText('请填写内存大小，单位是 GB。')).toBeTruthy();
  await user.click(up);
  expect(max.value).toBe('1');
  expect(screen.queryByText('请填写内存大小，单位是 GB。')).toBeNull();
  expect(validity.at(-1)).toBe(true);
});

test('内存：旧值离整数 GB 只差几 MiB（4100M 显示 4）时，箭头照样能加减', async () => {
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

test('初始内存：箭头加减算手动设置；Paper Aikar 锁定时箭头也点不了', async () => {
  const user = userEvent.setup();
  const { initial } = await open('-Xms1024M -Xmx8192M');
  await user.click(screen.getByRole('button', { name: '初始内存加 1 GB' }));
  expect(initial.value).toBe('2');
  expect(emitted.at(-1)).toBe('-Xms2048M -Xmx8192M');
  // 手动设置过，改最大内存不再带着它走。
  await user.click(screen.getByRole('button', { name: '最大内存加 1 GB' }));
  expect(emitted.at(-1)).toBe('-Xms2048M -Xmx9216M');

  await user.selectOptions(screen.getByLabelText('优化方案'), 'paper-aikar');
  expect(initial.disabled).toBe(true);
  for (const name of ['初始内存加 1 GB', '初始内存减 1 GB']) {
    expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
  }
  // 最大内存照常能加减，初始内存跟着。
  await user.click(screen.getByRole('button', { name: '最大内存减 1 GB' }));
  expect(emitted.at(-1)).toMatch(/^-Xms8192M -Xmx8192M /);
});

test('内存：最大内存只给 8 / 10 / 12 GB 三档，点档位直接填入', async () => {
  const user = userEvent.setup();
  const { max, tiers } = await open('-Xms1024M -Xmx2048M');
  expect(tierNames(tiers)).toEqual(['8 GB', '10 GB', '12 GB']);
  // 当前 2 GB 不在档位里，哪一档都不算选中；也不再标「推荐」。
  expect(within(tiers!).getAllByRole('button').some((button) => button.getAttribute('aria-pressed') === 'true')).toBe(false);
  const eight = within(tiers!).getByRole('button', { name: '8 GB' });
  // 档位不能是提交按钮，否则在 <form> 里点一下就提交了。
  expect(eight.getAttribute('type')).toBe('button');

  await user.click(eight);
  expect(max.value).toBe('8');
  expect(emitted.at(-1)).toBe('-Xms1024M -Xmx8192M');
  expect(eight.getAttribute('aria-pressed')).toBe('true');

  // 框里填错时点档位：直接换成这一档，错误消失。
  await user.clear(max);
  await user.tab();
  const error = screen.getByText('请填写内存大小，单位是 GB。');
  // 错误行必须排在档位后面：排在前面的话它一出现就把档位顶下去，正要点的那一下会点空（jsdom 没有布局，只能查顺序）。
  expect(tiers!.compareDocumentPosition(error) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await user.click(within(tiers!).getByRole('button', { name: '10 GB' }));
  expect(max.value).toBe('10');
  expect(screen.queryByText('请填写内存大小，单位是 GB。')).toBeNull();
  expect(emitted.at(-1)).toBe('-Xms1024M -Xmx10240M');
  expect(validity.at(-1)).toBe(true);
});

test('内存：档位按主机内存过滤；读不到主机内存时三档都给', async () => {
  const initialTiers = () => tierNames(screen.queryByRole('group', { name: '常用初始内存' }));
  totalMemMb = 8192;
  const small = await open('-Xms1024M -Xmx2048M');
  expect(tierNames(small.tiers)).toEqual(['8 GB']);
  expect(initialTiers()).toEqual(['2 GB', '4 GB', '6 GB']);
  cleanup();

  totalMemMb = 4096;
  const tiny = await open('-Xms1024M -Xmx2048M');
  // 一档都放不下时整组不显示，免得留一个空的按钮组。
  expect(tiny.tiers).toBeNull();
  expect(initialTiers()).toEqual(['2 GB', '4 GB']);
  cleanup();

  totalMemMb = null;
  const unknown = await open('-Xms1024M -Xmx2048M');
  expect(tierNames(unknown.tiers)).toEqual(['8 GB', '10 GB', '12 GB']);
  expect(initialTiers()).toEqual(['2 GB', '4 GB', '6 GB']);
});

test('初始内存：下面有 2 / 4 / 6 GB 三档，点了算手动设置，之后改最大内存不跟着变', async () => {
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

  // 比最大内存还大时照样填进去，由下面的诊断说明为什么不能保存。
  await user.click(within(screen.getByRole('group', { name: '常用最大内存' })).getByRole('button', { name: '8 GB' }));
  await user.clear(screen.getByLabelText('最大内存'));
  await user.type(screen.getByLabelText('最大内存'), '3');
  expect(emitted.at(-1)).toBe('-Xms4096M -Xmx3072M');
  expect(screen.getByText('初始内存不能大于最大内存')).toBeTruthy();
  expect(validity.at(-1)).toBe(false);
});

test('初始内存：在基础区直接填，没改过时跟着最大内存走，改过就不再跟', async () => {
  const user = userEvent.setup();
  const { max, initial } = await open('-Xms1024M -Xmx4096M');
  expect(initial.type).toBe('text');
  expect(initial.disabled).toBe(false);
  expect(initial.value).toBe('1');
  // 高级区里不再有「手动设置初始内存」，初始内存也不藏在折叠区里。
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(initial.closest('details')).toBeNull();

  // 兼容优先：没改过时初始内存取 1 GB。
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

  // 改过初始内存后再改最大内存，初始内存不跟着变。
  await user.click(within(screen.getByRole('group', { name: '常用最大内存' })).getByRole('button', { name: '8 GB' }));
  expect(emitted.at(-1)).toBe('-Xms2048M -Xmx8192M');
  expect(initial.value).toBe('2');
});

test('G1 均衡：切过去时初始内存自动等于最大内存，之后跟着最大内存走；切回兼容优先变回 1 GB', async () => {
  const user = userEvent.setup();
  const { max, initial } = await open('-Xms1024M -Xmx4096M');
  // 先手动改过初始内存，切到 G1 时也照样改成和最大内存一样。
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

  // G1 下也能自己改初始内存，改了说明就去掉。
  await user.clear(initial);
  await user.type(initial, '4');
  expect(emitted.at(-1)).toMatch(/^-Xms4096M -Xmx12288M /);
  expect(screen.queryByText('G1 均衡下和最大内存相同。')).toBeNull();

  // 切回兼容优先不动用户改过的；再切 G1 又对齐，然后切回兼容优先就是 1 GB。
  await user.selectOptions(screen.getByLabelText('优化方案'), 'compatibility');
  expect(emitted.at(-1)).toBe('-Xms4096M -Xmx12288M');
  await user.selectOptions(screen.getByLabelText('优化方案'), 'g1-balanced');
  await user.selectOptions(screen.getByLabelText('优化方案'), 'compatibility');
  expect(emitted.at(-1)).toBe('-Xms1024M -Xmx12288M');
  expect(max.value).toBe('12');
});

test('Paper Aikar：初始内存锁定成和最大内存相同，并说明原因', async () => {
  const user = userEvent.setup();
  const { initial } = await open('-Xms1024M -Xmx6144M');
  await user.selectOptions(screen.getByLabelText('优化方案'), 'paper-aikar');
  expect(emitted.at(-1)).toMatch(/^-Xms6144M -Xmx6144M /);
  expect(initial.disabled).toBe(true);
  expect(initial.value).toBe('6');
  // 锁定时初始内存的档位也点不了。
  for (const button of within(screen.getByRole('group', { name: '常用初始内存' })).getAllByRole('button')) {
    expect((button as HTMLButtonElement).disabled).toBe(true);
  }
  expect(screen.getByText('Paper Aikar 要求和最大内存相同。')).toBeTruthy();
  expect(initial.getAttribute('aria-describedby')!.split(' ').map((id) => document.getElementById(id)!.textContent))
    .toContain('Paper Aikar 要求和最大内存相同。');
});

test('已保存的 G1 实例初始内存和最大内存不同：打开时原样显示、不外发，改最大内存时也不动初始内存', async () => {
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


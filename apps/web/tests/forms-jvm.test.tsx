// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
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

/** 渲染并等主机内存读回来（档位过滤和「推荐」都靠它）。 */
async function open(initial: string) {
  render(<Host initial={initial} />);
  const tiers = screen.getByRole('group', { name: '常用内存大小' });
  if (totalMemMb !== null) await screen.findByText(/^这台电脑共/);
  else await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  return { max: screen.getByLabelText('最大内存') as HTMLInputElement, tiers };
}

const tierNames = (tiers: HTMLElement) => within(tiers).getAllByRole('button').map((button) => button.textContent);

test('内存：按 GB 填，发出的仍是 MiB 的 jvmArgs，小数也能填', async () => {
  const user = userEvent.setup();
  const { max } = await open('-Xms1024M -Xmx2048M');
  // 两个内存框都不再是 type="number"。
  expect(screen.queryByRole('spinbutton')).toBeNull();
  expect(max.type).toBe('text');
  expect(max.inputMode).toBe('decimal');
  expect(max.value).toBe('2');
  // 单位和「这台电脑共……」都读给读屏。
  const described = max.getAttribute('aria-describedby')!.split(' ').map((id) => document.getElementById(id)!.textContent);
  expect(described).toContain('GB');
  expect(described).toContain('这台电脑共 31 GB');

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

  // 改别的项时用的还是原来的 2500M，不是 2.44 × 1024。
  await user.selectOptions(screen.getByLabelText('优化方案'), 'g1-balanced');
  expect(emitted.at(-1)).toContain('-Xmx2500M');
  expect(emitted.at(-1)).toContain('-Xms1024M');

  // 删掉又填回同一个数，也还是 2500M。
  await user.clear(max);
  await user.type(max, '2.44');
  expect(max.value).toBe('2.44');
  expect(emitted.at(-1)).toContain('-Xmx2500M');
  expect(emitted.some((value) => value.includes('-Xmx2499M'))).toBe(false);
});

test('内存：点档位直接填入，推荐值不是整数 GB 时也有一档并标「推荐」', async () => {
  const user = userEvent.setup();
  const { max, tiers } = await open('-Xms1024M -Xmx2048M');
  // 32000 MiB 的机器：推荐 7680 MiB（7.5 GB），32 GB 那一档超出主机内存。
  expect(tierNames(tiers)).toEqual(['1 GB', '2 GB', '4 GB', '6 GB', '7.5 GB推荐', '8 GB', '12 GB', '16 GB', '24 GB']);
  const two = within(tiers).getByRole('button', { name: '2 GB' });
  expect(two.getAttribute('aria-pressed')).toBe('true');
  // 档位不能是提交按钮，否则在 <form> 里点一下就提交了。
  expect(two.getAttribute('type')).toBe('button');

  const recommended = within(tiers).getByRole('button', { name: /^7\.5 GB/ });
  await user.click(recommended);
  expect(max.value).toBe('7.5');
  expect(emitted.at(-1)).toBe('-Xms1024M -Xmx7680M');
  expect(recommended.getAttribute('aria-pressed')).toBe('true');
  expect(two.getAttribute('aria-pressed')).toBe('false');

  // 框里填错时点档位：直接换成这一档，错误消失。
  await user.clear(max);
  await user.tab();
  const error = screen.getByText('请填写内存大小，单位是 GB。');
  // 错误行必须排在档位后面：排在前面的话它一出现就把档位顶下去，正要点的那一下会点空（jsdom 没有布局，只能查顺序）。
  expect(tiers.compareDocumentPosition(error) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await user.click(within(tiers).getByRole('button', { name: '4 GB' }));
  expect(max.value).toBe('4');
  expect(screen.queryByText('请填写内存大小，单位是 GB。')).toBeNull();
  expect(emitted.at(-1)).toBe('-Xms1024M -Xmx4096M');
  expect(validity.at(-1)).toBe(true);
});

test('内存：档位按主机内存过滤；读不到主机内存时不过滤，也不写「这台电脑共……」', async () => {
  totalMemMb = 8192;
  const small = await open('-Xms1024M -Xmx2048M');
  expect(tierNames(small.tiers)).toEqual(['1 GB', '2 GB推荐', '4 GB', '6 GB', '8 GB']);
  expect(screen.getByText('这台电脑共 8 GB')).toBeTruthy();
  cleanup();

  totalMemMb = null;
  const unknown = await open('-Xms1024M -Xmx2048M');
  expect(tierNames(unknown.tiers)).toEqual(['1 GB', '2 GB推荐', '4 GB', '6 GB', '8 GB', '12 GB', '16 GB', '24 GB', '32 GB']);
  expect(screen.queryByText(/这台电脑共/)).toBeNull();
  // 没有说明时输入框只关联单位。
  expect(unknown.max.getAttribute('aria-describedby')!.split(' ')).toHaveLength(1);
});

test('初始内存：也按 GB 填，没勾「手动设置」时禁用并跟着最大内存走', async () => {
  const user = userEvent.setup();
  const { max } = await open('-Xms1024M -Xmx4096M');
  const initial = screen.getByLabelText('初始内存') as HTMLInputElement;
  expect(initial.type).toBe('text');
  expect(initial.disabled).toBe(true);
  expect(initial.value).toBe('1');

  await user.click(screen.getByRole('checkbox', { name: '手动设置初始内存 Xms' }));
  expect(initial.disabled).toBe(false);
  await user.clear(initial);
  expect(initial.value).toBe('');
  expect(validity.at(-1)).toBe(false);
  await user.type(initial, '2');
  expect(emitted.at(-1)).toBe('-Xms2048M -Xmx4096M');
  expect(validity.at(-1)).toBe(true);

  // 删空后关掉手动：没填完的文本不留，也不再算不合法。
  await user.clear(initial);
  await user.click(screen.getByRole('checkbox', { name: '手动设置初始内存 Xms' }));
  expect(initial.disabled).toBe(true);
  expect(initial.value).toBe('1');
  expect(emitted.at(-1)).toBe('-Xms1024M -Xmx4096M');
  expect(validity.at(-1)).toBe(true);
  expect(max.value).toBe('4');
});

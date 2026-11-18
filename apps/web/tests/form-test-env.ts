import { vi } from 'vitest';

/**
 * 表单类测试共用的环境，在 beforeEach 里调用。和 interactions.test.tsx 的做法一致：
 * 界面语言固定为 zh-CN（按中文原文查元素），补上 jsdom 没有的 matchMedia 和原生对话框方法。
 * 请求替身各测试文件自己用 vi.stubGlobal('fetch', …) 写，afterEach 里记得 vi.unstubAllGlobals()。
 */
export function setupFormTestEnv(): void {
  localStorage.clear();
  sessionStorage.clear();
  document.documentElement.lang = 'zh-CN';
  document.documentElement.dataset.localePreference = 'zh-CN';
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} });
  // jsdom 不实现原生模态层；这个替身只管开关状态，不证明真实浏览器里的焦点约束。
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () {
    if (!this.open) return;
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
  // jsdom 没有 scrollIntoView；「跳到出错字段」会调用它。
  Element.prototype.scrollIntoView = vi.fn();
}

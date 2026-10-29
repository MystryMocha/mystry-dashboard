import { useEffect, useRef } from 'react';

/** 懒加载页面或实例详情可能稍后才渲染出主标题，超过这个时间仍未出现就放弃移动焦点。 */
const HEADING_WAIT_MS = 10_000;

let userInteracted = false;
let interactionListening = false;

/** 首次键盘或指针操作之前的跳转（首屏加载、登录态重定向）不移动焦点，避免打断首屏朗读。 */
function listenForFirstInteraction(): void {
  if (userInteracted || interactionListening || typeof document === 'undefined') return;
  interactionListening = true;
  const mark = () => {
    userInteracted = true;
    interactionListening = false;
    document.removeEventListener('keydown', mark, true);
    document.removeEventListener('pointerdown', mark, true);
  };
  document.addEventListener('keydown', mark, true);
  document.addEventListener('pointerdown', mark, true);
}

/**
 * 把焦点移到新页面的主标题：优先主内容区里的 h1，登录页等没有外壳的页面取其他 h1。
 * Suspense 切换时旧页面会以 display: none 隐藏留在 DOM 里，这类标题和聚焦不上的标题都跳过。
 */
function focusHeading(): boolean {
  const candidates = [
    ...document.querySelectorAll<HTMLElement>('main h1'),
    ...document.querySelectorAll<HTMLElement>('h1'),
  ];
  for (const heading of candidates) {
    if (heading.closest('[hidden], [style*="display: none"]')) continue;
    // 标题本身不可聚焦，只允许脚本聚焦，不进入 Tab 顺序。
    if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
    if (document.activeElement === heading) return true;
  }
  return false;
}

/**
 * 页面切换后把焦点移到新页面的 h1，让读屏用户知道页面已经变化。
 * pageKey 相同（如同一实例内切换标签）时不移动焦点，焦点留在用户点过的标签上。
 */
export function useRouteFocus(pageKey: string): void {
  const previousKey = useRef<string | null>(null);

  useEffect(() => {
    listenForFirstInteraction();
  }, []);

  useEffect(() => {
    const previous = previousKey.current;
    previousKey.current = pageKey;
    if (previous === null || previous === pageKey || !userInteracted) return;

    const origin = document.activeElement;
    // 等标题出现期间用户若已自行把焦点移到别处，就不再抢回来。
    const focusStillUnclaimed = () => {
      const active = document.activeElement;
      return !active || active === document.body || active === origin || !active.isConnected;
    };

    if (focusHeading()) return;
    const observer = new MutationObserver(() => {
      if (!focusStillUnclaimed() || focusHeading()) stop();
    });
    const timer = window.setTimeout(() => stop(), HEADING_WAIT_MS);
    function stop() {
      observer.disconnect();
      window.clearTimeout(timer);
    }
    // Suspense 揭示新页面时会改 style，一并监听属性变化。
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'hidden'] });
    return stop;
  }, [pageKey]);
}

/** 测试用：重置「用户是否已操作过」的模块状态。 */
export function resetRouteFocusForTests(): void {
  userInteracted = false;
  interactionListening = false;
}

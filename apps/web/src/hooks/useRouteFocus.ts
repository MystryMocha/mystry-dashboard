import { useEffect, useRef } from 'react';

/** A lazy-loaded page or instance detail may render its main heading a little later; if it still has not appeared after this time, moving focus is abandoned. */
const HEADING_WAIT_MS = 10_000;

let userInteracted = false;
let interactionListening = false;

/** Navigations before the first keyboard or pointer interaction (initial load, auth redirect) do not move focus, so the initial screen reading is not interrupted. */
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
 * Moves focus to the new page's main heading: the h1 in the main content area is preferred, and pages without the shell, such as login, use another h1.
 * During a Suspense switch the old page stays in the DOM hidden with display: none; such headings, and headings that cannot take focus, are skipped.
 */
function focusHeading(): boolean {
  const candidates = [
    ...document.querySelectorAll<HTMLElement>('main h1'),
    ...document.querySelectorAll<HTMLElement>('h1'),
  ];
  for (const heading of candidates) {
    if (heading.closest('[hidden], [style*="display: none"]')) continue;
    // The heading itself is not focusable; only script focus is allowed, and it does not enter the Tab order.
    if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
    if (document.activeElement === heading) return true;
  }
  return false;
}

/**
 * After a page switch, moves focus to the new page's h1, so screen reader users know the page has changed.
 * When pageKey is the same (such as switching tabs within the same instance) focus is not moved and stays on the tab the user clicked.
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
    // If the user has already moved focus elsewhere while waiting for the heading to appear, it is not taken back.
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
    // Suspense changes style when revealing the new page, so attribute changes are observed too.
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'hidden'] });
    return stop;
  }, [pageKey]);
}

/** For tests: resets the "has the user interacted" module state. */
export function resetRouteFocusForTests(): void {
  userInteracted = false;
  interactionListening = false;
}

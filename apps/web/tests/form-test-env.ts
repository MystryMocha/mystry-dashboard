import { vi } from 'vitest';

/**
 * Environment shared by form tests, called in beforeEach. Same approach as interactions.test.tsx:
 * the UI language is fixed to zh-CN (elements are looked up by the Chinese text), and matchMedia and the native dialog methods jsdom lacks are filled in.
 * Each test file writes its own request stub with vi.stubGlobal('fetch', …); remember vi.unstubAllGlobals() in afterEach.
 */
export function setupFormTestEnv(): void {
  localStorage.clear();
  sessionStorage.clear();
  document.documentElement.lang = 'zh-CN';
  document.documentElement.dataset.localePreference = 'zh-CN';
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} });
  // jsdom does not implement the native modal layer; this stub only tracks open state and does not prove focus trapping in a real browser.
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () {
    if (!this.open) return;
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
  // jsdom has no scrollIntoView; "jump to the failing field" calls it.
  Element.prototype.scrollIntoView = vi.fn();
}

/**
 * Copies text. Opening the panel at http://192.168.x.x or a virtual-network address is not a secure context, so navigator.clipboard is unavailable;
 * the standard API is tried first, falling back to a hidden textarea plus execCommand. Returns false when both fail, and the caller prompts for a manual copy.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Use the approach below when permission is denied or the page has no focus
  }
  return copyWithTextarea(text);
}

function copyWithTextarea(text: string): boolean {
  if (typeof document.execCommand !== 'function') return false;
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const area = document.createElement('textarea');
  area.value = text;
  area.readOnly = true;
  area.setAttribute('aria-hidden', 'true');
  // Kept inside the viewport but invisible: iOS does not allow selection when it is moved off screen; the 16px font size keeps iOS from zooming the page on focus.
  area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;font-size:16px;';
  // While a modal dialog is open, elements outside it cannot be focused, so it is attached inside the dialog.
  const host = document.querySelector('dialog[open]') ?? document.body;
  host.appendChild(area);
  try {
    area.focus({ preventScroll: true });
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
    previous?.focus({ preventScroll: true });
  }
}

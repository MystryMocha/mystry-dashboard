/**
 * 复制文本。用 http://192.168.x.x 或组网地址打开面板时不是安全上下文，navigator.clipboard 不可用，
 * 所以先试标准接口，不行再退回隐藏 textarea 加 execCommand。都失败时返回 false，由调用方提示手动复制。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 权限被拒或页面没有焦点时改用下面的办法
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
  // 放在视口内但看不见：移出屏幕时 iOS 不允许选中；字号 16px 避免 iOS 聚焦时放大页面。
  area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;font-size:16px;';
  // 打开着模态弹窗时，弹窗外的元素不可聚焦，所以挂到弹窗里。
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

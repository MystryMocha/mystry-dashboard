import { useEffect } from 'react';
import { useI18n } from '../i18n';

/** 品牌名不翻译；没有页面名时浏览器标签只显示它。 */
export const APP_TITLE = 'Mystry Dashboard';

/**
 * 按「页面名 · Mystry Dashboard」设置浏览器标签标题，让读屏和多标签用户分清当前页面。
 * 传入的页面名应已按当前语言翻译；切换语言后调用方重新渲染，标题随之更新。
 * 同一时刻只应有一个组件为当前路由设置标题，见 App.tsx 的 RouteAnnouncer。
 */
export function useDocumentTitle(page: string | null | undefined): void {
  const { t } = useI18n();
  const title = page ? t('shell.docTitle', { page }) : APP_TITLE;
  useEffect(() => {
    document.title = title;
  }, [title]);
}

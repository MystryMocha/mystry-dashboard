import { useEffect } from 'react';
import { useI18n } from '../i18n';

/** The brand name is not translated; when there is no page name the browser tab shows only it. */
export const APP_TITLE = 'Mystry Dashboard';

/**
 * Sets the browser tab title as "page name · Mystry Dashboard", so screen reader and multi-tab users can tell the current page.
 * The page name passed in should already be translated into the current language; after a language switch the caller re-renders and the title updates with it.
 * Only one component should set the title for the current route at any time; see RouteAnnouncer in App.tsx.
 */
export function useDocumentTitle(page: string | null | undefined): void {
  const { t } = useI18n();
  const title = page ? t('shell.docTitle', { page }) : APP_TITLE;
  useEffect(() => {
    document.title = title;
  }, [title]);
}

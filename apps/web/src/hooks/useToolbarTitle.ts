import { createContext, useContext, useEffect } from 'react';

/**
 * Title in the top bar capsule after scrolling: by default the fixed text for the route, which a page can replace with a more specific name (such as the instance name).
 * Cleared when the page unmounts, returning to the route text. Instance names are chosen by users and do not go through i18n.
 */
export const ToolbarTitleContext = createContext<(title: string | null) => void>(() => {});

export function useToolbarTitle(title: string | null): void {
  const setTitle = useContext(ToolbarTitleContext);
  useEffect(() => {
    setTitle(title);
    return () => setTitle(null);
  }, [setTitle, title]);
}

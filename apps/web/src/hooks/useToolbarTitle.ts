import { createContext, useContext, useEffect } from 'react';

/**
 * 滚动后顶栏胶囊里的标题：默认按路由显示固定文案，页面可以换成更具体的名字（如实例名）。
 * 页面卸载时清空，回到路由文案。实例名是用户自己起的，不进 i18n。
 */
export const ToolbarTitleContext = createContext<(title: string | null) => void>(() => {});

export function useToolbarTitle(title: string | null): void {
  const setTitle = useContext(ToolbarTitleContext);
  useEffect(() => {
    setTitle(title);
    return () => setTitle(null);
  }, [setTitle, title]);
}

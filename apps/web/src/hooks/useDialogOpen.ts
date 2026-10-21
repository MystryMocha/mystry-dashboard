import { useEffect, useRef } from 'react';

/** 按 open 打开或关闭原生 <dialog> 的模态层，返回要挂到 dialog 上的 ref。 */
export function useDialogOpen(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);
  return ref;
}

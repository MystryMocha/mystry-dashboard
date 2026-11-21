import { useEffect, useRef } from 'react';

/** Opens or closes the modal layer of a native <dialog> according to open, and returns the ref to attach to the dialog. */
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

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { IconButton } from "../components/primitives.js";

// Below this width, reserve the whole window for content instead of a sidebar column.
const narrowQuery = "(max-width: 700px)";

export function useSidebarDrawer() {
  const [narrow, setNarrow] = useState(() => matchMedia(narrowQuery).matches);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const show = useCallback(() => setOpen(true), []);
  useEffect(() => {
    const media = matchMedia(narrowQuery);
    const resize = () => {
      setNarrow(media.matches);
      close();
    };
    media.addEventListener("change", resize);
    window.addEventListener("hashchange", close);
    return () => {
      media.removeEventListener("change", resize);
      window.removeEventListener("hashchange", close);
    };
  }, [close]);
  return { narrow, open, close, show };
}

export function Sidebar({
  narrow,
  open,
  onClose,
  children,
}: {
  narrow: boolean;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (narrow && open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, [narrow, open]);
  const content = (
    <aside id="workspace-sidebar" className="workspace-sidebar" aria-label="Workspace sidebar">
      {narrow ? (
        <div className="sidebar-drawer-header">
          <strong>Workspace</strong>
          <IconButton icon="Close" label="Close sidebar" onClick={onClose} autoFocus />
        </div>
      ) : null}
      {children}
    </aside>
  );
  if (!narrow) return content;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: native dialog cancellation provides the Escape equivalent for backdrop clicks.
    <dialog
      ref={ref}
      className="sidebar-drawer"
      aria-label="Workspace navigation"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {content}
    </dialog>
  );
}

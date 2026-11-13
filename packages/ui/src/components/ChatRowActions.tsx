import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { Row } from "../chat/types.js";
import { text } from "../chat/types.js";
import { Icon } from "../shell/icons.js";
import { useShell } from "../state.js";
import { isThreadUnread, latestReadTimestamp, type RowStatus } from "../workspaces/activity.js";
import { clearSeen, markSeen } from "../workspaces/seen.js";
import { Button, Dialog, Field, IconButton, Input } from "./primitives.js";
import "./chat-row-actions.css";

export type ChatActionCall = (
  method: string,
  params: unknown,
  commandId?: string,
) => Promise<unknown>;

export interface ChatActionHandlers {
  pinned: boolean;
  archived: boolean;
  unread: boolean;
  onTogglePin(): Promise<void> | void;
  onToggleUnread(): Promise<void> | void;
  onRename(title: string): Promise<void>;
  onToggleArchive(): Promise<void> | void;
  onDelete(): Promise<void>;
}

type MenuAnchor =
  | { kind: "point"; x: number; y: number; returnFocusTo?: HTMLElement | null | undefined }
  | { kind: "rect"; rect: DOMRect; returnFocusTo?: HTMLElement | null | undefined };

let closeActiveMenu: (() => void) | undefined;

function navigateAfterThreadRemoval(thread: Row) {
  const shell = useShell.getState();
  const id = text(thread.id);
  if (shell.route !== "Chat" || shell.threadId !== id) return;
  const node =
    thread.node && typeof thread.node === "object"
      ? (thread.node as { type?: unknown; id?: unknown })
      : undefined;
  if (node?.type === "subproject" && typeof node.id === "string" && node.id) {
    shell.openScope({ type: "subproject", id: node.id });
    return;
  }
  const projectId = text(thread.projectId);
  if (projectId) {
    shell.openScope({ type: "project", id: projectId });
    return;
  }
  shell.navigate("Overview");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Could not complete that action.";
}

/** Whether a thread can be pinned, renamed, archived, or deleted from chat lists. */
export function isManageableThread(
  thread: Row,
  options?: { compareMembers?: readonly Row[] | undefined; chiefId?: string | undefined },
): boolean {
  const id = text(thread.id);
  if (thread.kind === "task" || Boolean(thread.taskId)) return false;
  if (options?.chiefId && id === options.chiefId) return false;
  if (options?.compareMembers?.some((member) => member.threadId === id)) return false;
  return true;
}

/** Shared handlers for Workspace/Team `Thread` rows across sidebar tree, Workspace home, All chats, and Overview. */
export function createThreadActions(options: {
  thread: Row;
  rowStatus?: RowStatus | undefined;
  turns?: readonly Row[] | undefined;
  call: ChatActionCall;
}): ChatActionHandlers {
  const { thread, rowStatus, turns, call } = options;
  const id = text(thread.id);
  const pinned = Boolean(thread.pinned);
  const archived = Boolean(thread.archived);
  const unread = isThreadUnread(rowStatus);
  return {
    pinned,
    archived,
    unread,
    async onTogglePin() {
      await call("thread.pin", { id, pinned: !pinned }, `thread-pin:${id}:${crypto.randomUUID()}`);
    },
    async onToggleUnread() {
      if (unread) {
        const at = latestReadTimestamp(id, thread, turns);
        markSeen(id, at);
        await call("thread.markRead", { id, at }, `thread-read:${id}:${at}`);
        return;
      }
      clearSeen(id);
      await call("thread.markUnread", { id }, `thread-unread:${id}:${crypto.randomUUID()}`);
    },
    async onRename(nextTitle: string) {
      await call(
        "thread.rename",
        { id, title: nextTitle.trim() },
        `thread-rename:${id}:${crypto.randomUUID()}`,
      );
    },
    async onToggleArchive() {
      if (archived) {
        await call("thread.unarchive", { id }, `thread-unarchive:${id}:${crypto.randomUUID()}`);
        return;
      }
      await call(
        "thread.archive",
        { id, confirmed: true },
        `thread-archive:${id}:${crypto.randomUUID()}`,
      );
      navigateAfterThreadRemoval(thread);
    },
    async onDelete() {
      await call(
        "thread.delete",
        { id, confirmed: true },
        `thread-delete:${id}:${crypto.randomUUID()}`,
      );
      navigateAfterThreadRemoval(thread);
    },
  };
}

/**
 * Wraps a chat row `<button>` with sibling hover/focus Pin + 3-dots controls,
 * right-click + keyboard (`ContextMenu` / `Shift+F10`) top-layer menu, and modal Rename/Delete dialogs.
 * Never nests `<button>` inside `<button>`.
 */
export function ChatRowShell({
  title,
  actions,
  enabled = true,
  className = "",
  onError,
  children,
}: {
  title: string;
  actions?: ChatActionHandlers | undefined;
  enabled?: boolean | undefined;
  className?: string | undefined;
  onError?: ((message: string) => void) | undefined;
  children: ReactNode;
}) {
  const shellRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const menuId = useId();
  const [anchor, setAnchor] = useState<MenuAnchor>();
  const [position, setPosition] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  const [dialog, setDialog] = useState<"rename" | "delete">();
  const [draft, setDraft] = useState(title);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const menuOpen = Boolean(anchor);

  const closeMenu = useCallback((restoreFocus = false) => {
    setAnchor((current) => {
      if (restoreFocus && current?.returnFocusTo) {
        const target = current.returnFocusTo;
        requestAnimationFrame(() => target.focus());
      }
      return undefined;
    });
  }, []);

  const reportError = useCallback(
    (error: unknown) => {
      onError?.(errorMessage(error));
    },
    [onError],
  );

  const openMenu = useCallback(
    (next: MenuAnchor) => {
      if (!enabled || !actions) return;
      if (closeActiveMenu) closeActiveMenu();
      closeActiveMenu = () => closeMenu(false);
      setAnchor(next);
    },
    [actions, closeMenu, enabled],
  );

  // Clean up module-level active menu reference on unmount.
  useEffect(() => {
    return () => {
      if (menuOpen) closeActiveMenu = undefined;
    };
  }, [menuOpen]);

  // Keyboard ContextMenu / Shift+F10 shortcut without attaching listeners to a non-interactive div in JSX.
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell || !enabled || !actions) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
      event.preventDefault();
      event.stopPropagation();
      const target =
        event.target instanceof HTMLElement
          ? event.target
          : (shell.firstElementChild as HTMLElement);
      openMenu({
        kind: "rect",
        rect: (moreRef.current ?? shell).getBoundingClientRect(),
        returnFocusTo: target,
      });
    };
    shell.addEventListener("keydown", onKeyDown);
    return () => shell.removeEventListener("keydown", onKeyDown);
  }, [actions, enabled, openMenu]);

  // Dismiss open menu on outside pointerdown, Escape, window resize, or any scroll.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (menuRef.current?.contains(target) || moreRef.current?.contains(target)) return;
      closeMenu(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
    };
    const onDismiss = () => closeMenu(false);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", onDismiss);
    window.addEventListener("scroll", onDismiss, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", onDismiss);
      window.removeEventListener("scroll", onDismiss, true);
      closeActiveMenu = undefined;
    };
  }, [closeMenu, menuOpen]);

  // Measure rendered menu dimensions and clamp within viewport bounds (top-layer popover).
  useLayoutEffect(() => {
    if (!anchor || !menuRef.current) return;
    const menu = menuRef.current;
    try {
      (menu as HTMLElement & { showPopover?: () => void }).showPopover?.();
    } catch {}
    const rect = menu.getBoundingClientRect();
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left: number;
    let top: number;
    if (anchor.kind === "point") {
      left = anchor.x + rect.width > vw - margin ? anchor.x - rect.width : anchor.x;
      top = anchor.y + rect.height > vh - margin ? anchor.y - rect.height : anchor.y;
    } else {
      left = Math.min(anchor.rect.right - rect.width, vw - rect.width - margin);
      if (anchor.rect.bottom + 4 + rect.height <= vh - margin) {
        top = anchor.rect.bottom + 4;
      } else {
        top = anchor.rect.top - rect.height - 4;
      }
    }
    setPosition({
      left: Math.max(margin, Math.min(left, vw - rect.width - margin)),
      top: Math.max(margin, Math.min(top, vh - rect.height - margin)),
    });
    menu.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    return () => {
      try {
        (menu as HTMLElement & { hidePopover?: () => void }).hidePopover?.();
      } catch {}
    };
  }, [anchor]);

  // Focus & select name field when Rename dialog opens.
  useEffect(() => {
    if (dialog !== "rename") return;
    requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
  }, [dialog]);

  if (!enabled || !actions) {
    return <div className={`chat-row-shell ${className}`.trimEnd()}>{children}</div>;
  }

  const runAction = (work: () => Promise<void> | void) => {
    closeMenu(false);
    Promise.resolve().then(work).catch(reportError);
  };

  const portalTarget =
    typeof document !== "undefined"
      ? (shellRef.current?.closest("dialog[open]") ?? document.body)
      : null;

  const menuItems = [
    {
      label: actions.pinned ? "Unpin" : "Pin",
      icon: actions.pinned ? "PinOff" : "Pin",
      danger: false,
      onSelect: () => runAction(() => actions.onTogglePin()),
    },
    {
      label: actions.unread ? "Mark read" : "Mark unread",
      icon: actions.unread ? "Read" : "Unread",
      danger: false,
      onSelect: () => runAction(() => actions.onToggleUnread()),
    },
    {
      label: "Rename…",
      icon: "Edit",
      danger: false,
      onSelect: () => {
        closeMenu(false);
        setDraft(title);
        setDialogError("");
        setDialog("rename");
      },
    },
    {
      label: actions.archived ? "Unarchive" : "Archive",
      icon: actions.archived ? "Unarchive" : "Archive",
      danger: false,
      onSelect: () => runAction(() => actions.onToggleArchive()),
    },
    {
      label: "Delete…",
      icon: "Delete",
      danger: true,
      onSelect: () => {
        closeMenu(false);
        setDialogError("");
        setDialog("delete");
      },
    },
  ];

  const menuNode =
    menuOpen && portalTarget
      ? createPortal(
          <div
            ref={menuRef}
            id={menuId}
            className="zb-menu chat-context-menu"
            role="menu"
            popover="manual"
            aria-label={`Actions for ${title}`}
            tabIndex={-1}
            style={{ left: `${position.left}px`, top: `${position.top}px` }}
            onKeyDown={(event) => {
              const entries = [
                ...(menuRef.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []),
              ];
              const at = entries.indexOf(document.activeElement as HTMLElement);
              const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
              if (step) {
                event.preventDefault();
                entries[(at + step + entries.length) % entries.length]?.focus();
              } else if (event.key === "Home") {
                event.preventDefault();
                entries[0]?.focus();
              } else if (event.key === "End") {
                event.preventDefault();
                entries.at(-1)?.focus();
              } else if (event.key === "Tab") {
                closeMenu(false);
              }
            }}
          >
            {menuItems.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={`zb-menu-item${item.danger ? " danger" : ""}`}
                onClick={() => item.onSelect()}
              >
                <Icon name={item.icon} size="md" />
                <span className="zb-row-label">{item.label}</span>
              </button>
            ))}
          </div>,
          portalTarget,
        )
      : null;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: native desktop contextmenu triggers on the row container beside sibling action buttons.
    <div
      ref={shellRef}
      className={`chat-row-shell${actions.pinned ? " is-pinned" : ""}${actions.unread ? " is-unread" : ""}${menuOpen ? " menu-open" : ""} ${className}`.trimEnd()}
      onContextMenu={(event) => {
        if (event.target instanceof Element && event.target.closest("dialog, [role=menu]")) return;
        event.preventDefault();
        event.stopPropagation();
        openMenu({
          kind: "point",
          x: event.clientX,
          y: event.clientY,
          returnFocusTo: shellRef.current?.querySelector<HTMLElement>("button"),
        });
      }}
    >
      {children}
      <div className="chat-row-actions">
        <IconButton
          icon="Pin"
          size="sm"
          className={`chat-pin-btn${actions.pinned ? " pinned" : ""}`}
          label={`${actions.pinned ? "Unpin" : "Pin"} ${title}`}
          onClick={(event) => {
            event.stopPropagation();
            Promise.resolve()
              .then(() => actions.onTogglePin())
              .catch(reportError);
          }}
        />
        <IconButton
          ref={moreRef}
          icon="More"
          size="sm"
          className="chat-more-btn"
          label={`More actions for ${title}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? menuId : undefined}
          onClick={(event) => {
            event.stopPropagation();
            if (menuOpen) {
              closeMenu(true);
              return;
            }
            const rect = event.currentTarget.getBoundingClientRect();
            openMenu({ kind: "rect", rect, returnFocusTo: event.currentTarget });
          }}
        />
      </div>
      {menuNode}
      {dialog === "rename" ? (
        <Dialog open title="Rename chat" onClose={() => !busy && setDialog(undefined)}>
          <form
            id={`${menuId}-rename`}
            onSubmit={(event) => {
              event.preventDefault();
              const nextTitle = draft.trim();
              if (!nextTitle || busy) return;
              setBusy(true);
              setDialogError("");
              void actions
                .onRename(nextTitle)
                .then(() => setDialog(undefined))
                .catch((error) => setDialogError(errorMessage(error)))
                .finally(() => setBusy(false));
            }}
          >
            <Field label="Name">
              <Input
                ref={renameInputRef}
                value={draft}
                disabled={busy}
                maxLength={200}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    (event.nativeEvent.isComposing || event.keyCode === 229)
                  )
                    event.preventDefault();
                }}
              />
            </Field>
            {dialogError ? (
              <p role="alert" className="chat-rename-error">
                {dialogError}
              </p>
            ) : null}
            <div className="zb-dialog-actions">
              <Button disabled={busy} onClick={() => setDialog(undefined)}>
                Cancel
              </Button>
              <Button variant="primary" type="submit" disabled={busy || !draft.trim()}>
                Save
              </Button>
            </div>
          </form>
        </Dialog>
      ) : null}
      {dialog === "delete" ? (
        <Dialog
          open
          title={`Delete “${title}”?`}
          description="Its messages are removed from this Mac."
          onClose={() => !busy && setDialog(undefined)}
          actions={
            <>
              <Button autoFocus disabled={busy} onClick={() => setDialog(undefined)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setDialogError("");
                  void actions
                    .onDelete()
                    .then(() => setDialog(undefined))
                    .catch((error) => setDialogError(errorMessage(error)))
                    .finally(() => setBusy(false));
                }}
              >
                Delete chat
              </Button>
            </>
          }
        >
          {dialogError ? (
            <p role="alert" className="chat-rename-error">
              {dialogError}
            </p>
          ) : null}
        </Dialog>
      ) : null}
    </div>
  );
}

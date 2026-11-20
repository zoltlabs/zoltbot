// C1: messages waiting for the agent. Each row can be sent now, edited (taken back into the
// composer), removed, or moved: drag the handle, press Alt+↑/↓ on it, or use the row's menu.
// A move shows at once and is undone if the daemon refuses it.
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import type { QueueDelivery, QueueSnapshot } from "../../../../shared/ipc";
import { t } from "../../i18n";
import { Menu, type MenuItem } from "../../kit";
import { memoryError } from "../../memory-store";
import { MoreIcon } from "./icons";
import { moved } from "./queue-order";
import "../../queue-list.css";

function GripIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <g fill="currentColor">
        <circle cx="6" cy="4" r="1.2" />
        <circle cx="10" cy="4" r="1.2" />
        <circle cx="6" cy="8" r="1.2" />
        <circle cx="10" cy="8" r="1.2" />
        <circle cx="6" cy="12" r="1.2" />
        <circle cx="10" cy="12" r="1.2" />
      </g>
    </svg>
  );
}

export function QueueList(props: {
  botId: string | undefined;
  queue: QueueSnapshot | undefined;
  visible: boolean;
  onResume: () => void;
  onCancel: (deliveryId: string) => void;
  /** Puts a queued message's text back in the composer after it left the queue. */
  onEdit: (text: string) => void;
}) {
  const queued = () => props.queue?.deliveries.filter((item) => item.status === "queued") ?? [];
  const [order, setOrder] = createSignal<string[] | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [announcement, setAnnouncement] = createSignal("");
  const [menu, setMenu] = createSignal<{ id: string; anchor: HTMLElement } | null>(null);
  const [dragging, setDragging] = createSignal<string | null>(null);
  let list: HTMLOListElement | undefined;

  // The order shown early stays until the daemon's order matches it, so a second quick move
  // isn't undone by the snapshot of the first. A queue with other messages drops it.
  createEffect(
    on(
      () => queued().map((item) => item.id),
      (ids) => {
        const local = order();
        if (!local) return;
        const same = ids.length === local.length && ids.every((id) => local.includes(id));
        if (!same || ids.join("|") === local.join("|")) setOrder(null);
      },
      { defer: true },
    ),
  );

  const byId = createMemo(() => new Map(queued().map((item) => [item.id, item])));
  // Rows are keyed by id, not by item: each snapshot brings new objects, and a row rebuilt
  // under the cursor would drop keyboard focus.
  const ids = createMemo(() => {
    const local = order();
    return local ? local.filter((id) => byId().has(id)) : queued().map((item) => item.id);
  });
  const rows = () => ids().flatMap((id) => byId().get(id) ?? []);
  const preview = (item: QueueDelivery) => item.text.trim() || t("queue.attachment");
  /** Accessible names read on every Tab stop, so they carry only the start of the message. */
  const short = (item: QueueDelivery) => {
    const text = preview(item).replace(/\s+/g, " ");
    return text.length > 40 ? `${text.slice(0, 39)}…` : text;
  };
  const focusComposer = () => {
    const field = list
      ?.closest(".composer-wrap")
      ?.querySelector("[contenteditable='true'], textarea");
    if (field instanceof HTMLElement) field.focus();
  };
  /** Before a row leaves, moves focus to the next row's menu button, or the composer. */
  function focusAfterLeaving(id: string) {
    const ids = rows().map((row) => row.id);
    const at = ids.indexOf(id);
    const next = ids[at + 1] ?? ids[at - 1];
    setTimeout(() => {
      const button = next
        ? list?.querySelector(`[data-queue-id="${CSS.escape(next)}"] .queue-row-menu`)
        : null;
      if (button instanceof HTMLElement) button.focus();
      else focusComposer();
    }, 0);
  }

  async function reorder(next: string[], focusId?: string) {
    const botId = props.botId;
    if (!botId) return;
    setError(null);
    setOrder(next);
    if (focusId) {
      setAnnouncement(
        t("queue.movedTo", { position: next.indexOf(focusId) + 1, count: next.length }),
      );
      queueMicrotask(() => {
        const grip = list?.querySelector(`[data-queue-id="${CSS.escape(focusId)}"] .queue-grip`);
        if (grip instanceof HTMLElement) grip.focus();
      });
    }
    try {
      await window.openbot.queue.reorder({ botId, order: next });
    } catch {
      setOrder(null);
      setError(t("queue.moveFailed"));
    }
  }

  function move(id: string, by: number) {
    const ids = rows().map((item) => item.id);
    const next = moved(ids, id, ids.indexOf(id) + by);
    if (next) void reorder(next, id);
  }

  async function sendNow(id: string) {
    const botId = props.botId;
    if (!botId) return;
    setError(null);
    focusAfterLeaving(id);
    try {
      await window.openbot.queue.sendNow({ botId, deliveryId: id });
    } catch (failure) {
      setError(memoryError(failure));
    }
  }

  async function edit(item: QueueDelivery) {
    const botId = props.botId;
    if (!botId) return;
    setError(null);
    try {
      await window.openbot.agent.cancelQueuedMessage({ botId, deliveryId: item.id });
      props.onEdit(item.text);
      setTimeout(() => {
        focusComposer();
        const selection = document.getSelection();
        const active = document.activeElement;
        if (selection && active?.getAttribute("contenteditable") === "true") {
          selection.selectAllChildren(active);
          selection.collapseToEnd();
        }
      }, 0);
    } catch (failure) {
      setError(memoryError(failure));
    }
  }

  function menuGroups(item: QueueDelivery): MenuItem[][] {
    const index = rows().findIndex((row) => row.id === item.id);
    return [
      [
        { id: "send", label: t("queue.sendNow"), run: () => void sendNow(item.id) },
        {
          id: "edit",
          label: t("queue.edit"),
          disabled: !item.editable,
          run: () => void edit(item),
        },
      ],
      [
        {
          id: "up",
          label: t("queue.moveUp"),
          shortcut: "⌥↑",
          disabled: index <= 0,
          run: () => move(item.id, -1),
        },
        {
          id: "down",
          label: t("queue.moveDown"),
          shortcut: "⌥↓",
          disabled: index === rows().length - 1,
          run: () => move(item.id, 1),
        },
      ],
      [
        {
          id: "remove",
          label: t("queue.remove"),
          danger: true,
          run: () => {
            focusAfterLeaving(item.id);
            props.onCancel(item.id);
          },
        },
      ],
    ];
  }

  return (
    <div
      class="agent-queue-bar queue-list-host"
      classList={{ "agent-queue-bar-visible": props.visible }}
      inert={!props.visible}
    >
      <section class="queue-list" aria-labelledby="queue-list-title">
        <header class="queue-list-header">
          <h2 id="queue-list-title">
            {rows().length === 0
              ? t("queue.paused")
              : props.queue?.paused
                ? t("queue.titlePaused", { count: rows().length })
                : t("queue.title", { count: rows().length })}
          </h2>
          <Show when={props.queue?.paused}>
            <button type="button" class="queue-list-resume" onClick={props.onResume}>
              {t("queue.resume")}
            </button>
          </Show>
        </header>
        <Show when={error()}>
          <p class="queue-list-error" role="alert">
            {error()}
          </p>
        </Show>
        <ol ref={list}>
          <For each={ids()}>
            {(id) => {
              let last: QueueDelivery | undefined;
              const item = () => {
                last = byId().get(id) ?? last;
                return last as QueueDelivery;
              };
              return (
                <li
                  data-queue-id={id}
                  classList={{ "queue-row-dragging": dragging() === id }}
                  onDragOver={(event) => {
                    const from = dragging();
                    if (!from || from === id) return;
                    event.preventDefault();
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const from = dragging();
                    setDragging(null);
                    if (!from || from === id) return;
                    const ids = rows().map((row) => row.id);
                    const next = moved(ids, from, ids.indexOf(id));
                    if (next) void reorder(next, from);
                  }}
                >
                  <button
                    type="button"
                    class="queue-grip"
                    draggable={true}
                    aria-label={t("queue.move", { message: short(item()) })}
                    aria-keyshortcuts="ArrowUp ArrowDown"
                    title={t("queue.moveHint")}
                    onDragStart={(event) => {
                      setDragging(id);
                      event.dataTransfer?.setData("text/plain", id);
                      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
                    }}
                    onDragEnd={() => setDragging(null)}
                    onKeyDown={(event) => {
                      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                      event.preventDefault();
                      move(id, event.key === "ArrowUp" ? -1 : 1);
                    }}
                  >
                    <GripIcon />
                  </button>
                  <span class="queue-row-text">{preview(item())}</span>
                  <button
                    type="button"
                    class="queue-row-menu"
                    aria-label={t("queue.actions", { message: short(item()) })}
                    aria-haspopup="menu"
                    aria-expanded={menu()?.id === id}
                    onClick={(event) => setMenu({ id, anchor: event.currentTarget })}
                  >
                    <MoreIcon />
                  </button>
                  <Show when={menu()?.id === id ? menu() : null}>
                    {(open) => (
                      <Menu
                        anchor={open().anchor}
                        label={t("queue.actionsMenu")}
                        groups={menuGroups(item())}
                        placement="top-end"
                        onClose={() => setMenu(null)}
                      />
                    )}
                  </Show>
                </li>
              );
            }}
          </For>
        </ol>
        <span class="sr-only" aria-live="polite">
          {announcement()}
        </span>
      </section>
    </div>
  );
}

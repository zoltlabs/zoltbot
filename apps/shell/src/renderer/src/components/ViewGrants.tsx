import { createSignal, For, Show } from "solid-js";
import type { ViewPermission, ViewShortcut } from "../../../shared/ipc";
import { Popover } from "../kit";

/** What each permission lets a view do, as the grant card and the permissions menu show it. */
export const permissionText: Record<ViewPermission, { label: string; detail?: string }> = {
  read: { label: "See your chats, projects, requests and spending" },
  act: {
    label: "Send messages to your agents and stop them",
    detail: "Agents act on these messages as if you wrote them.",
  },
  approve: {
    label: "Answer approvals and questions for you",
    detail: "Zoltbot still asks you before anything that allows more than one action.",
  },
};

interface GrantCardProps {
  name: string;
  /** The permissions to ask about, in manifest order. */
  pending: ViewPermission[];
  granted: ViewPermission[];
  busy: boolean;
  error: string;
  /** Saves `permissions` as the view's whole grant. */
  onSave: (permissions: ViewPermission[]) => void;
}

/** Asks the person for the permissions the view requested and doesn't have yet. */
export function GrantCard(props: GrantCardProps) {
  const [selected, setSelected] = createSignal(new Set(props.pending));
  const headingId = `view-grants-${Math.random().toString(36).slice(2)}`;
  // Without read the view can't load, so read is what allowing means here.
  const required = (permission: ViewPermission) =>
    permission === "read" && !props.granted.includes("read");
  const chosen = () => props.pending.filter((permission) => selected().has(permission));
  const all = () => chosen().length === props.pending.length;
  const save = (permissions: ViewPermission[]) =>
    props.onSave([...new Set([...props.granted, ...permissions])]);

  return (
    <section class="view-grant-card" aria-labelledby={headingId}>
      <h2 id={headingId} class="view-grant-title">
        Allow {props.name} to
      </h2>
      <ul class="view-grant-list">
        <For each={props.pending}>
          {(permission) => (
            <li>
              <label class="view-grant-option">
                <input
                  type="checkbox"
                  checked={selected().has(permission)}
                  disabled={required(permission) || props.busy}
                  onChange={(event) => {
                    const next = new Set(selected());
                    if (event.currentTarget.checked) next.add(permission);
                    else next.delete(permission);
                    setSelected(next);
                  }}
                />
                <span>
                  <strong>{permissionText[permission].label}</strong>
                  <Show when={permissionText[permission].detail}>
                    {(detail) => <span>{detail()}</span>}
                  </Show>
                </span>
              </label>
            </li>
          )}
        </For>
      </ul>
      <Show when={props.error}>
        <p class="view-grant-error" role="alert">
          {props.error}
        </p>
      </Show>
      <div class="view-grant-actions">
        <Show when={props.granted.includes("read")}>
          <button
            type="button"
            class="view-grant-secondary"
            disabled={props.busy}
            onClick={() => save([])}
          >
            Not now
          </button>
        </Show>
        <button
          type="button"
          class="map-action"
          disabled={props.busy || !chosen().length}
          onClick={() => save(chosen())}
        >
          {all() ? "Allow all" : "Allow selected"}
        </button>
      </div>
    </section>
  );
}

interface PermissionsMenuProps {
  name: string;
  requested: ViewPermission[];
  granted: ViewPermission[];
  busy: boolean;
  error: string;
  onSave: (permissions: ViewPermission[]) => void;
}

/** The header button that shows what the view may do, with a switch to grant or revoke each. */
export function PermissionsMenu(props: PermissionsMenuProps) {
  const [open, setOpen] = createSignal(false);
  let button: HTMLButtonElement | undefined;

  return (
    <div class="view-permissions no-drag">
      <button
        ref={button}
        type="button"
        class="view-permissions-button"
        aria-haspopup="dialog"
        aria-expanded={open()}
        onClick={() => setOpen(!open())}
      >
        Permissions
      </button>
      <Show when={open() && button}>
        {(anchor) => (
          <Popover
            anchor={anchor()}
            label={`${props.name} permissions`}
            placement="bottom-end"
            width={320}
            onClose={() => setOpen(false)}
          >
            <div class="view-permissions-popover">
              <For each={props.requested}>
                {(permission) => {
                  const on = () => props.granted.includes(permission);
                  return (
                    <div class="view-permissions-row">
                      <span>
                        <strong>{permissionText[permission].label}</strong>
                        <Show when={permissionText[permission].detail}>
                          {(detail) => <span>{detail()}</span>}
                        </Show>
                      </span>
                      <button
                        type="button"
                        role="switch"
                        class="settings-switch"
                        classList={{ "settings-switch-on": on() }}
                        aria-checked={on()}
                        aria-label={permissionText[permission].label}
                        // Stays focusable while a change saves, so keyboard focus isn't lost.
                        aria-disabled={props.busy}
                        onClick={() => {
                          if (props.busy) return;
                          props.onSave(
                            on()
                              ? props.granted.filter((item) => item !== permission)
                              : [...props.granted, permission],
                          );
                        }}
                      >
                        <span />
                      </button>
                    </div>
                  );
                }}
              </For>
              <Show when={props.error}>
                <p class="view-grant-error" role="alert">
                  {props.error}
                </p>
              </Show>
            </div>
          </Popover>
        )}
      </Show>
    </div>
  );
}

const MODIFIERS = new Set(["mod", "cmd", "meta", "ctrl", "control", "shift", "alt", "option"]);

/**
 * Whether a key press is one of a view's declared shortcuts, written like `Space` or `mod+k`.
 * `mod` is Command on macOS and Control elsewhere.
 */
export function matchesShortcut(
  keys: string,
  event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  mac = navigator.platform.toLowerCase().includes("mac"),
): boolean {
  const parts = keys
    .toLowerCase()
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  const key = parts.at(-1);
  if (!key || MODIFIERS.has(key)) return false;
  const wants = new Set(parts.slice(0, -1));
  const meta = wants.has("cmd") || wants.has("meta") || (mac && wants.has("mod"));
  const ctrl = wants.has("ctrl") || wants.has("control") || (!mac && wants.has("mod"));
  if (
    event.metaKey !== meta ||
    event.ctrlKey !== ctrl ||
    event.shiftKey !== wants.has("shift") ||
    event.altKey !== (wants.has("alt") || wants.has("option"))
  )
    return false;
  if (key === "space") return event.code === "Space";
  return event.key.toLowerCase() === key;
}

/** The shortcut a key press runs, unless focus is somewhere that uses the key itself. */
export function shortcutFor(
  shortcuts: ViewShortcut[],
  event: KeyboardEvent,
): ViewShortcut | undefined {
  if (event.defaultPrevented || event.repeat) return undefined;
  const target = event.target;
  if (
    target instanceof Element &&
    target.closest(
      "input, textarea, select, button, a[href], summary, iframe, [contenteditable], [role=switch], [role=dialog]",
    )
  )
    return undefined;
  return shortcuts.find((shortcut) => matchesShortcut(shortcut.keys, event));
}

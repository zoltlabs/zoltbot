// D11: the account menu's Keyboard item: every shortcut, with Change and Reset.
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { shortcuts } from "../app-shortcuts";
import { t } from "../i18n";
import { Dialog, type MenuItem } from "../kit";
import { normalizeKeys } from "../shortcuts";
import { conflictFor, displayKeys, keysFromEvent, type ListedShortcut } from "./keys";
import "./keyboard.css";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

function KeyboardIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="size-4 fill-none stroke-current">
      <rect x="2.5" y="5" width="15" height="10" rx="2" stroke-width="1.5" />
      <path
        d="M6 12.5h8M6 8.5h.01M9 8.5h.01M12 8.5h.01M15 8.5h.01"
        stroke-width="1.5"
        stroke-linecap="round"
      />
    </svg>
  );
}

export function KeyboardDialog(props: { onClose: () => void }) {
  const preferences = window.openbot.preferences;
  const [bindings, setBindings] = createSignal<Record<string, string>>({});
  const [recording, setRecording] = createSignal<string | null>(null);
  const [conflict, setConflict] = createSignal<{ id: string; label: string } | null>(null);
  const defaults = () =>
    new Map(shortcuts.list().map((shortcut) => [shortcut.id, shortcut.defaultKeys]));

  const list = (): ListedShortcut[] =>
    shortcuts.list().map((shortcut) => ({
      ...shortcut,
      keys: bindings()[shortcut.id] ?? shortcut.defaultKeys,
    }));
  onMount(() => {
    void preferences
      ?.get()
      .then((saved) => setBindings({ ...saved.keyBindings }))
      .catch(() => undefined);
  });

  function save(next: Record<string, string>) {
    setBindings(next);
    void preferences?.set({ keyBindings: next }).catch(() => undefined);
  }

  function record(event: KeyboardEvent) {
    const id = recording();
    if (!id) return;
    // Capture before the app's shortcuts see the press.
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      setRecording(null);
      return;
    }
    const keys = keysFromEvent(event, isMac);
    if (!keys) return;
    const used = conflictFor(id, keys, list());
    if (used) {
      setConflict({ id, label: used });
      return;
    }
    setConflict(null);
    setRecording(null);
    const next = { ...bindings() };
    if (keys === normalizeKeys(defaults().get(id) ?? "")) delete next[id];
    else next[id] = keys;
    save(next);
  }

  onMount(() => window.addEventListener("keydown", record, true));
  onCleanup(() => window.removeEventListener("keydown", record, true));

  return (
    <Dialog
      title={t("keyboard.title")}
      width={520}
      onClose={() => {
        if (!recording()) props.onClose();
      }}
      actions={
        <button type="button" class="zb-kit-button primary" onClick={props.onClose}>
          {t("sounds.done")}
        </button>
      }
    >
      <ul class="keyboard-list">
        <For each={list()}>
          {(shortcut) => (
            <li class="keyboard-row">
              <span class="keyboard-label">{shortcut.label}</span>
              <span class="keyboard-keys" aria-live="polite">
                <Show
                  when={recording() === shortcut.id}
                  fallback={<kbd>{displayKeys(shortcut.keys, isMac)}</kbd>}
                >
                  <span class="keyboard-recording">{t("keyboard.pressKeys")}</span>
                </Show>
              </span>
              <span class="keyboard-actions">
                <button
                  type="button"
                  class="zb-kit-button"
                  aria-label={t("keyboard.changeFor", { command: shortcut.label })}
                  onClick={() => {
                    setConflict(null);
                    setRecording(shortcut.id);
                  }}
                >
                  {t("keyboard.change")}
                </button>
                <Show when={bindings()[shortcut.id]}>
                  <button
                    type="button"
                    class="zb-kit-button"
                    aria-label={t("keyboard.resetFor", { command: shortcut.label })}
                    onClick={() => {
                      const next = { ...bindings() };
                      delete next[shortcut.id];
                      save(next);
                    }}
                  >
                    {t("keyboard.reset")}
                  </button>
                </Show>
              </span>
              <Show when={conflict()?.id === shortcut.id}>
                <p class="zb-kit-error keyboard-conflict" role="alert">
                  {t("keyboard.conflict", { command: conflict()?.label ?? "" })}
                </p>
              </Show>
            </li>
          )}
        </For>
      </ul>
    </Dialog>
  );
}

export function createKeyboardEntry() {
  const [open, setOpen] = createSignal(false);
  return {
    item: (): MenuItem => ({
      id: "keyboard",
      label: t("keyboard.title"),
      icon: <KeyboardIcon />,
      run: () => setOpen(true),
    }),
    Dialog: () => (
      <Show when={open()}>
        <KeyboardDialog onClose={() => setOpen(false)} />
      </Show>
    ),
  };
}

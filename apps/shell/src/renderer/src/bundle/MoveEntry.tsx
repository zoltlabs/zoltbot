// D7: the account menu's Move to another computer item, so the sidebar adds one line each.
import { createSignal, For, Show } from "solid-js";
import type { BundlePreview } from "../../../shared/bundle";
import { t } from "../i18n";
import { Dialog, type MenuItem, Stack } from "../kit";
import "./move.css";

function MoveIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="size-4 fill-none stroke-current">
      <path
        d="M3 6h11m0 0-3-3m3 3-3 3M17 14H6m0 0 3-3m-3 3 3 3"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

function ImportDialog(props: { preview: BundlePreview; onClose: () => void }) {
  const [busy, setBusy] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  async function apply() {
    setBusy(true);
    setFailed(false);
    try {
      await window.openbot.bundle?.apply({
        previewId: props.preview.previewId,
        selected: props.preview.items.map((item) => item.id),
      });
      props.onClose();
    } catch {
      setFailed(true);
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={t("move.importTitle", { count: props.preview.agents })}
      width={460}
      busy={busy()}
      onClose={props.onClose}
      actions={
        <>
          <button type="button" class="zb-kit-button" disabled={busy()} onClick={props.onClose}>
            {t("move.cancel")}
          </button>
          <button
            type="button"
            class="zb-kit-button primary"
            disabled={busy() || props.preview.items.length === 0}
            onClick={() => void apply()}
          >
            {t("move.import")}
          </button>
        </>
      }
    >
      <Stack gap={3}>
        <ul class="move-items">
          <For each={props.preview.items}>
            {(item) => (
              <li>
                <span class="move-item-name">{item.name}</span>
                <Show when={item.action === "replace"}>
                  <span class="move-item-replace">{t("move.replaces")}</span>
                </Show>
              </li>
            )}
          </For>
        </ul>
        <Show when={props.preview.tools.length > 0}>
          <p>{t("move.setUpFirst", { tools: props.preview.tools.join(", ") })}</p>
        </Show>
        <Show when={props.preview.connections.length > 0}>
          <p>{t("move.signInAgain", { names: props.preview.connections.join(", ") })}</p>
        </Show>
        <Show when={failed()}>
          <p class="zb-kit-error">{t("move.importFailed")}</p>
        </Show>
      </Stack>
    </Dialog>
  );
}

export function MoveDialog(props: { onClose: () => void }) {
  const bundle = window.openbot.bundle;
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [preview, setPreview] = createSignal<BundlePreview | null>(null);

  async function exportBundle() {
    setBusy(true);
    setError(null);
    try {
      if ((await bundle?.export())?.saved) props.onClose();
    } catch {
      setError(t("move.exportFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function importBundle() {
    setBusy(true);
    setError(null);
    try {
      const next = await bundle?.preview();
      if (next) setPreview(next);
    } catch {
      setError(t("move.notAnExport"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Show
      when={preview()}
      fallback={
        <Dialog
          title={t("move.title")}
          width={420}
          busy={busy()}
          onClose={props.onClose}
          actions={
            <>
              <button
                type="button"
                class="zb-kit-button"
                disabled={busy()}
                onClick={() => void importBundle()}
              >
                {t("move.importOpen")}
              </button>
              <button
                type="button"
                class="zb-kit-button primary"
                disabled={busy()}
                onClick={() => void exportBundle()}
              >
                {t("move.export")}
              </button>
            </>
          }
        >
          <Stack gap={2}>
            <p>{t("move.note")}</p>
            <Show when={error()}>{(message) => <p class="zb-kit-error">{message()}</p>}</Show>
          </Stack>
        </Dialog>
      }
    >
      {(next) => <ImportDialog preview={next()} onClose={props.onClose} />}
    </Show>
  );
}

export function createMoveEntry() {
  const [open, setOpen] = createSignal(false);
  return {
    item: (): MenuItem => ({
      id: "move-computer",
      label: t("move.title"),
      icon: <MoveIcon />,
      run: () => setOpen(true),
    }),
    Dialog: () => (
      <Show when={open()}>
        <MoveDialog onClose={() => setOpen(false)} />
      </Show>
    ),
  };
}

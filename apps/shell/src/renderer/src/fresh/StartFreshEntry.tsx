// D6: the account menu's Start fresh item and its confirmation, so the sidebar adds one line each.
import { createSignal, For, Show } from "solid-js";
import { confirmsStartFresh, START_FRESH_PHRASE } from "../../../shared/start-fresh";
import { t } from "../i18n";
import { Dialog, Field, type MenuItem, Stack } from "../kit";
import "./fresh.css";

function FreshIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="size-4 fill-none stroke-current">
      <path
        d="M4.5 10a5.5 5.5 0 1 0 1.6-3.9M4.5 3.5v3h3"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

export function StartFreshDialog(props: { onClose: () => void }) {
  const fresh = window.openbot.fresh;
  const [typed, setTyped] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const [kept, setKept] = createSignal<string[] | null>(null);

  async function restart() {
    setBusy(true);
    await fresh?.restart().catch(() => {
      setBusy(false);
      setFailed(true);
    });
  }

  async function run() {
    if (!fresh || !confirmsStartFresh(typed(), t("fresh.phrase")) || busy()) return;
    setBusy(true);
    setFailed(false);
    try {
      const result = await fresh.run(START_FRESH_PHRASE);
      if (result.kept.length === 0) return void (await restart());
      setKept(result.kept);
      setBusy(false);
    } catch {
      setBusy(false);
      setFailed(true);
    }
  }

  return (
    <Show
      when={kept()}
      fallback={
        <Dialog
          title={t("fresh.title")}
          role="alertdialog"
          width={420}
          busy={busy()}
          onClose={props.onClose}
          initialFocus="input"
          actions={
            <>
              <button type="button" class="zb-kit-button" disabled={busy()} onClick={props.onClose}>
                {t("fresh.cancel")}
              </button>
              <button
                type="button"
                class="zb-kit-button danger"
                disabled={busy() || !confirmsStartFresh(typed(), t("fresh.phrase"))}
                onClick={() => void run()}
              >
                {t("fresh.confirm")}
              </button>
            </>
          }
        >
          <Stack gap={3}>
            <p>{t("fresh.body")}</p>
            <Field
              label={t("fresh.typeToConfirm", { phrase: t("fresh.phrase") })}
              error={failed() ? t("fresh.failed") : null}
              input={(id, describedBy) => (
                <input
                  id={id}
                  class="zb-kit-input"
                  autocomplete="off"
                  spellcheck={false}
                  aria-describedby={describedBy}
                  value={typed()}
                  disabled={busy()}
                  onInput={(event) => setTyped(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void run();
                  }}
                />
              )}
            />
          </Stack>
        </Dialog>
      }
    >
      {(folders) => (
        // Past the point of no return: the only way on is the restart.
        <Dialog
          title={t("fresh.keptTitle")}
          width={460}
          busy
          onClose={() => undefined}
          actions={
            <button
              type="button"
              class="zb-kit-button primary"
              disabled={busy()}
              onClick={() => void restart()}
            >
              {t("fresh.restart")}
            </button>
          }
        >
          <Stack gap={2}>
            <ul class="fresh-kept">
              <For each={folders()}>{(folder) => <li>{folder}</li>}</For>
            </ul>
            <Show when={failed()}>
              <p class="zb-kit-error">{t("fresh.restartFailed")}</p>
            </Show>
          </Stack>
        </Dialog>
      )}
    </Show>
  );
}

export function createStartFreshEntry() {
  const [open, setOpen] = createSignal(false);
  return {
    item: (): MenuItem => ({
      id: "start-fresh",
      label: t("fresh.open"),
      icon: <FreshIcon />,
      danger: true,
      run: () => setOpen(true),
    }),
    Dialog: () => (
      <Show when={open()}>
        <StartFreshDialog onClose={() => setOpen(false)} />
      </Show>
    ),
  };
}

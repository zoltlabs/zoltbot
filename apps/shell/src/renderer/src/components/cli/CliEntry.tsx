// R5: the account menu's "Install command-line tool" item and its confirmation, so the sidebar
// adds one line each.
import { createSignal, Show } from "solid-js";
import type { CliState } from "../../../../shared/cli";
import { t } from "../../i18n";
import { ConfirmDialog, type MenuItem, showToast } from "../../kit";

function TerminalIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="size-4 fill-none stroke-current">
      <path
        d="M3.5 4.5h13v11h-13zM6.5 8.5l2 1.5-2 1.5M10.5 12h3"
        stroke-width="1.4"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

const PROBLEMS: Partial<Record<CliState, "sidebar.cli.other" | "sidebar.cli.unavailable">> = {
  other: "sidebar.cli.other",
  unavailable: "sidebar.cli.unavailable",
};

export function createCliEntry() {
  const cli = window.openbot?.cli;
  const [open, setOpen] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [state, setState] = createSignal<CliState | null>(null);
  const refresh = () =>
    void cli
      ?.status()
      .then(setState)
      .catch(() => setState(null));
  refresh();

  async function install() {
    setBusy(true);
    setError(null);
    try {
      const before = state();
      const next = await cli?.install();
      if (next) setState(next);
      const problem = next ? PROBLEMS[next] : undefined;
      if (problem) {
        setError(t(problem));
        return;
      }
      // The password prompt was cancelled: nothing changed, so the dialog stays as it was.
      if (next === before) return;
      setOpen(false);
      showToast({ message: t("sidebar.cli.installed") });
    } catch {
      setError(t("sidebar.cli.failed"));
    } finally {
      setBusy(false);
    }
  }

  return {
    item: (): MenuItem | undefined =>
      // Shown while there is something to do: install, update, or a zolt in the way.
      cli && (state() === "missing" || state() === "outdated" || state() === "other")
        ? {
            id: "cli",
            label: t(state() === "outdated" ? "sidebar.cli.update" : "sidebar.cli.install"),
            icon: <TerminalIcon />,
            run: () => {
              setError(state() === "other" ? t("sidebar.cli.other") : null);
              setOpen(true);
            },
          }
        : undefined,
    Dialog: () => (
      <Show when={open()}>
        <ConfirmDialog
          title={t("sidebar.cli.title")}
          body={t("sidebar.cli.body")}
          confirmLabel={t("sidebar.cli.confirm")}
          busyLabel={t("sidebar.cli.busy")}
          busy={busy()}
          error={error()}
          onConfirm={() => void install()}
          onCancel={() => {
            setOpen(false);
            refresh();
          }}
        />
      </Show>
    ),
  };
}

// I1: the account menu's Bridges item and the dialog it opens, so the sidebar adds one line each.
import { createSignal, Show } from "solid-js";
import { t } from "../../i18n";
import type { MenuItem } from "../../kit";
import { BridgesDialog } from "./BridgesDialog";

function BridgesIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="size-4 fill-none stroke-current">
      <path
        d="M3 13.5c2-4 4-6 7-6s5 2 7 6M5.5 10.5v5M10 7.5v8M14.5 10.5v5"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

export function createBridgesEntry() {
  const [open, setOpen] = createSignal(false);
  return {
    item: (): MenuItem => ({
      id: "bridges",
      label: t("sidebar.account.bridges"),
      icon: <BridgesIcon />,
      run: () => setOpen(true),
    }),
    Dialog: () => (
      <Show when={open()}>
        <BridgesDialog onClose={() => setOpen(false)} />
      </Show>
    ),
  };
}

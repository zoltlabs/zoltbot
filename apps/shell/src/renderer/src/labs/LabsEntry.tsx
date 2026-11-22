// The account menu's Experimental item: features still being tried, each off by default.
import { createSignal, Show } from "solid-js";
import { t } from "../i18n";
import { Dialog, type MenuItem, SettingsRow, Stack } from "../kit";
import { Switch } from "../sounds/SoundsEntry";
import { setSidebarRail, sidebarRail } from "./sidebar-rail";

function LabsIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="size-4 fill-none stroke-current">
      <path
        d="M8 3.5h4M8.75 3.5v4.5L4.6 15a1.2 1.2 0 0 0 1 1.8h8.8a1.2 1.2 0 0 0 1-1.8L11.25 8V3.5"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path d="M6.5 12.5h7" stroke-width="1.5" stroke-linecap="round" />
    </svg>
  );
}

export function LabsDialog(props: { onClose: () => void }) {
  return (
    <Dialog
      title={t("labs.title")}
      width={400}
      onClose={props.onClose}
      actions={
        <button type="button" class="zb-kit-button primary" onClick={props.onClose}>
          {t("sounds.done")}
        </button>
      }
    >
      <Stack gap={3}>
        <SettingsRow
          label={t("labs.sidebarRail")}
          control={(id) => (
            <Switch id={id} on={sidebarRail()} flip={() => setSidebarRail(!sidebarRail())} />
          )}
        />
      </Stack>
    </Dialog>
  );
}

export function createLabsEntry() {
  const [open, setOpen] = createSignal(false);
  return {
    item: (): MenuItem => ({
      id: "experimental",
      label: t("labs.title"),
      icon: <LabsIcon />,
      run: () => setOpen(true),
    }),
    Dialog: () => (
      <Show when={open()}>
        <LabsDialog onClose={() => setOpen(false)} />
      </Show>
    ),
  };
}

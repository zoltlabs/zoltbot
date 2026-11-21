// D4: the account menu's Agent dock item and its settings, so the sidebar adds one line each.
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { DOCK_POSITIONS, type DockPosition } from "../../../shared/dock";
import { DEFAULT_PREFERENCES } from "../../../shared/preferences";
import { t } from "../i18n";
import { Dialog, type MenuItem, Select, SettingsRow, Stack } from "../kit";
import { Switch } from "../sounds/SoundsEntry";

function DockIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="size-4 fill-none stroke-current">
      <rect x="3" y="4" width="14" height="12" rx="2.5" stroke-width="1.5" />
      <path d="M13.5 7v6" stroke-width="2" stroke-linecap="round" />
    </svg>
  );
}

// Keys spelled out, so the catalog check sees each one used.
const POSITION_LABELS: Record<DockPosition, () => string> = {
  right: () => t("dock.right"),
  left: () => t("dock.left"),
  top: () => t("dock.top"),
};

export function DockDialog(props: { onClose: () => void }) {
  const preferences = window.openbot.preferences;
  const [shown, setShown] = createSignal(DEFAULT_PREFERENCES.agentDock);
  const [position, setPosition] = createSignal(DEFAULT_PREFERENCES.agentDockPosition);
  onMount(() => {
    void preferences
      ?.get()
      .then((value) => {
        setShown(value.agentDock);
        setPosition(value.agentDockPosition);
      })
      .catch(() => undefined);
    const off = preferences?.onChange((value) => {
      setShown(value.agentDock);
      setPosition(value.agentDockPosition);
    });
    if (off) onCleanup(off);
  });
  return (
    <Dialog
      title={t("dock.settings")}
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
          label={t("dock.show")}
          control={(id) => (
            <Switch
              id={id}
              on={shown()}
              flip={() => {
                const next = !shown();
                setShown(next);
                void preferences?.set({ agentDock: next }).catch(() => undefined);
              }}
            />
          )}
        />
        <SettingsRow
          label={t("dock.position")}
          control={() => (
            <Select
              label={t("dock.position")}
              value={position()}
              disabled={!shown()}
              options={DOCK_POSITIONS.map((value) => ({ value, label: POSITION_LABELS[value]() }))}
              onChange={(value: DockPosition) => {
                setPosition(value);
                void preferences?.set({ agentDockPosition: value }).catch(() => undefined);
              }}
            />
          )}
        />
      </Stack>
    </Dialog>
  );
}

export function createDockEntry() {
  const [open, setOpen] = createSignal(false);
  return {
    item: (): MenuItem => ({
      id: "agent-dock",
      label: t("dock.settings"),
      icon: <DockIcon />,
      run: () => setOpen(true),
    }),
    Dialog: () => (
      <Show when={open()}>
        <DockDialog onClose={() => setOpen(false)} />
      </Show>
    ),
  };
}

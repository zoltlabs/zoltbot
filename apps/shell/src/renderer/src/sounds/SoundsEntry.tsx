// D2: the account menu's Sounds item and its dialog, so the sidebar adds one line each.
import { createSignal, For, Show } from "solid-js";
import { t } from "../i18n";
import { Dialog, type MenuItem, SettingsRow, Stack } from "../kit";
import {
  playSound,
  type SoundName,
  type SoundPreferences,
  setSoundPreferences,
  soundPreferences,
} from "./sounds";
import "./sounds.css";

function SoundsIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="size-4 fill-none stroke-current">
      <path
        d="M4 8v4h3l4 3V5L7 8H4ZM14 7.5a3.5 3.5 0 0 1 0 5"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

function Switch(props: { id: string; on: boolean; disabled?: boolean; flip: () => void }) {
  return (
    <button
      id={props.id}
      type="button"
      role="switch"
      class="settings-switch"
      classList={{ "settings-switch-on": props.on }}
      aria-checked={props.on}
      disabled={props.disabled}
      onClick={props.flip}
    >
      <span />
    </button>
  );
}

const EACH: { name: SoundName; key: keyof SoundPreferences; label: () => string }[] = [
  { name: "taskFinished", key: "soundTaskFinished", label: () => t("sounds.taskFinished") },
  { name: "needsYou", key: "soundNeedsYou", label: () => t("sounds.needsYou") },
  { name: "messageSent", key: "soundMessageSent", label: () => t("sounds.messageSent") },
];

export function SoundsDialog(props: { onClose: () => void }) {
  const prefs = soundPreferences;
  return (
    <Dialog
      title={t("sounds.title")}
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
          label={t("sounds.title")}
          control={(id) => (
            <Switch
              id={id}
              on={prefs().sounds}
              flip={() => setSoundPreferences({ sounds: !prefs().sounds })}
            />
          )}
        />
        <For each={EACH}>
          {(sound) => (
            <SettingsRow
              label={sound.label()}
              control={(id) => (
                <Switch
                  id={id}
                  on={prefs()[sound.key] === true}
                  disabled={!prefs().sounds}
                  flip={() => {
                    const on = prefs()[sound.key] !== true;
                    setSoundPreferences({ [sound.key]: on });
                    // Hear what was just turned on.
                    if (on) playSound(sound.name);
                  }}
                />
              )}
            />
          )}
        </For>
        <SettingsRow
          label={t("sounds.volume")}
          control={(id) => (
            <input
              id={id}
              type="range"
              class="sounds-volume"
              min="0"
              max="1"
              step="0.1"
              value={prefs().soundVolume}
              aria-valuetext={`${Math.round(prefs().soundVolume * 100)}%`}
              disabled={!prefs().sounds}
              onChange={(event) => {
                setSoundPreferences({ soundVolume: Number(event.currentTarget.value) });
                playSound("taskFinished");
              }}
            />
          )}
        />
      </Stack>
    </Dialog>
  );
}

export function createSoundsEntry() {
  const [open, setOpen] = createSignal(false);
  return {
    item: (): MenuItem => ({
      id: "sounds",
      label: t("sounds.title"),
      icon: <SoundsIcon />,
      run: () => setOpen(true),
    }),
    Dialog: () => (
      <Show when={open()}>
        <SoundsDialog onClose={() => setOpen(false)} />
      </Show>
    ),
  };
}

// D1: the account menu's Appearance item and the dialog it opens, so the sidebar adds one line each.
import { createSignal, For, Show } from "solid-js";
import {
  CHAT_BACKGROUNDS,
  type ChatBackgroundPreference,
  FONTS,
  type FontPreference,
  TEXT_SCALE,
  type TextSizePreference,
  type ThemePreference,
} from "../../../shared/preferences";
import { t } from "../i18n";
import { Dialog, type MenuItem, Select, SettingsRow, Stack } from "../kit";
import { appearance, setAppearance } from "./appearance";

function AppearanceIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="size-4 fill-none stroke-current">
      <circle cx="10" cy="10" r="6.5" stroke-width="1.5" />
      <path d="M10 3.5v13a6.5 6.5 0 0 0 0-13Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

// Keys spelled out, so the catalog check sees each one used.
const THEME_LABELS: Record<ThemePreference, () => string> = {
  system: () => t("appearance.system"),
  light: () => t("appearance.light"),
  dark: () => t("appearance.dark"),
};
const SIZE_LABELS: Record<TextSizePreference, () => string> = {
  small: () => t("appearance.size.small"),
  default: () => t("appearance.size.default"),
  large: () => t("appearance.size.large"),
  larger: () => t("appearance.size.larger"),
};
const FONT_LABELS: Record<FontPreference, () => string> = {
  system: () => t("appearance.font.system"),
  geist: () => t("appearance.font.geist"),
  serif: () => t("appearance.font.serif"),
};
const BACKGROUND_LABELS: Record<ChatBackgroundPreference, () => string> = {
  none: () => t("appearance.bg.none"),
  tint: () => t("appearance.bg.tint"),
  dots: () => t("appearance.bg.dots"),
  grid: () => t("appearance.bg.grid"),
};
type Labels = { [value: string]: () => string };
function options(values: readonly string[], labels: Labels) {
  return values.map((value) => ({ value, label: labels[value]?.() ?? value }));
}

export function AppearanceDialog(props: { onClose: () => void }) {
  const rows = [
    {
      label: t("appearance.theme"),
      value: () => appearance().theme,
      options: options(Object.keys(THEME_LABELS) as ThemePreference[], THEME_LABELS),
      set: (theme: string) => setAppearance({ theme: theme as ThemePreference }),
    },
    {
      label: t("appearance.textSize"),
      value: () => appearance().textSize,
      options: options(Object.keys(TEXT_SCALE) as TextSizePreference[], SIZE_LABELS),
      set: (textSize: string) => setAppearance({ textSize: textSize as TextSizePreference }),
    },
    {
      label: t("appearance.font"),
      value: () => appearance().font,
      options: options(FONTS, FONT_LABELS),
      set: (font: string) => setAppearance({ font: font as FontPreference }),
    },
    {
      label: t("appearance.chatBackground"),
      value: () => appearance().chatBackground,
      options: options(CHAT_BACKGROUNDS, BACKGROUND_LABELS),
      set: (chatBackground: string) =>
        setAppearance({ chatBackground: chatBackground as ChatBackgroundPreference }),
    },
  ];
  return (
    <Dialog
      title={t("appearance.title")}
      width={420}
      onClose={props.onClose}
      actions={
        <button type="button" class="zb-kit-button primary" onClick={props.onClose}>
          {t("appearance.done")}
        </button>
      }
    >
      <Stack gap={3}>
        <For each={rows}>
          {(row) => (
            <SettingsRow
              label={row.label}
              control={() => (
                <Select
                  label={row.label}
                  value={row.value()}
                  options={row.options}
                  onChange={row.set}
                />
              )}
            />
          )}
        </For>
      </Stack>
    </Dialog>
  );
}

export function createAppearanceEntry() {
  const [open, setOpen] = createSignal(false);
  return {
    item: (): MenuItem => ({
      id: "appearance",
      label: t("sidebar.account.appearance"),
      icon: <AppearanceIcon />,
      run: () => setOpen(true),
    }),
    Dialog: () => (
      <Show when={open()}>
        <AppearanceDialog onClose={() => setOpen(false)} />
      </Show>
    ),
  };
}

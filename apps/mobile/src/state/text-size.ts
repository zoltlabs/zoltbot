// P6: the text size stays on this iPhone. It loads at launch; a choice made before that wins.
import * as SecureStore from "expo-secure-store";
import { create } from "zustand";
import { readTextSize, type TextSize } from "../data/text-size";

const KEY = "zoltbot.textSize.v1";
let chosen = false;

export const useTextSize = create<{
  size: TextSize;
  load(): Promise<void>;
  set(size: TextSize): void;
}>((set, get) => ({
  size: 1,
  async load() {
    const raw = await SecureStore.getItemAsync(KEY).catch(() => null);
    if (!chosen) set({ size: readTextSize(raw) });
  },
  set(size) {
    chosen = true;
    // A drag passes each notch many times; only a change is saved.
    if (size === get().size) return;
    set({ size });
    void SecureStore.setItemAsync(KEY, String(size), {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    }).catch(() => undefined);
  },
}));

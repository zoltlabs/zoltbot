// Experimental: whether the sidebar's page buttons live in an icon rail. Off unless the
// owner turns it on under Experimental, so the current sidebar stays the default.
import { createRoot, createSignal } from "solid-js";
import { DEFAULT_PREFERENCES } from "../../../shared/preferences";

const [rail, setRail] = createRoot(() => createSignal(DEFAULT_PREFERENCES.sidebarRail));

let following = false;
function follow() {
  if (following) return;
  following = true;
  const preferences = window.openbot?.preferences;
  if (!preferences) return;
  preferences.onChange((value) => setRail(value.sidebarRail));
  void preferences
    .get()
    .then((value) => setRail(value.sidebarRail))
    .catch(() => undefined);
}

/** The saved setting. Reading it starts following the preference. */
export function sidebarRail(): boolean {
  follow();
  return rail();
}

export function setSidebarRail(on: boolean) {
  setRail(on);
  void window.openbot?.preferences?.set({ sidebarRail: on }).catch(() => undefined);
}

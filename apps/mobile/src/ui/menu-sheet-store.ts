// P10: the open Android menu. Android alerts show at most three buttons, so longer menus open
// as a sheet instead; `MenuSheet` renders whatever is here.
import type { MenuItem } from "./kit";

export type OpenMenu = { items: MenuItem[]; title?: string; message?: string };

let open: OpenMenu | undefined;
const listeners = new Set<() => void>();

export function openMenuSheet(menu: OpenMenu | undefined) {
  open = menu;
  for (const listener of listeners) listener();
}

export const menuSheet = {
  get: () => open,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

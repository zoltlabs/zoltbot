import { create } from "zustand";

export interface DrawerState {
  open: boolean;
  /** The project the drawer and the Tasks tab show; null until the person picks one. */
  projectId: string | null;
  set(patch: Partial<Omit<DrawerState, "set">>): void;
}

/** The side menu Home and Tasks open, and the project it shows. Stays on this phone. */
export const useDrawer = create<DrawerState>((set) => ({
  open: false,
  projectId: null,
  set: (patch) => set(patch),
}));

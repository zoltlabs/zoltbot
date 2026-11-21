// P7: the Home Screen icons the owner can choose. `native` is the icon set's name in the app
// (plugins/with-app-icons.cjs); the main icon has none.
export interface AppIconChoice {
  id: "classic" | "paper" | "amber" | "mono";
  name: string;
  native: string | null;
}

export const appIcons: readonly AppIconChoice[] = [
  { id: "classic", name: "Classic", native: null },
  { id: "paper", name: "Paper", native: "AppIcon-Paper" },
  { id: "amber", name: "Amber", native: "AppIcon-Amber" },
  { id: "mono", name: "Mono", native: "AppIcon-Mono" },
];

/** The choice iOS reports, or Classic for the main icon or a name this version doesn't know. */
export const appIconFor = (native: string | null | undefined): AppIconChoice =>
  appIcons.find((icon) => icon.native === (native ?? null)) ?? (appIcons[0] as AppIconChoice);

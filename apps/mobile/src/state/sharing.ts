import { NativeModules, Platform } from "react-native";
import { create } from "zustand";
import type { SharedDraft, ShareRecipient } from "../data/sharing";
import { shareRecipients } from "../data/sharing";
import { useLink } from "./link";

interface ShareBridge {
  syncRecipients(recipients: ShareRecipient[]): Promise<void>;
  listDrafts(): Promise<SharedDraft[]>;
  updateDraft(id: string, recipientId: string, message: string): Promise<void>;
  markDraftSent(id: string, threadId: string): Promise<void>;
  removeDraft(id: string): Promise<void>;
  donate(recipient: ShareRecipient): Promise<void>;
  /** P9, Android: a share the app was opened with, saved as a draft for this Mac. Once. */
  takeIncoming?(macId: string): Promise<string | null>;
}
// P9: Android implements the same bridge (native/android/share).
const bridge =
  Platform.OS === "ios" || Platform.OS === "android"
    ? (NativeModules.ZoltShare as ShareBridge | undefined)
    : undefined;
/** P4: Siri learns agent names from the share directory once it changes. */
const shortcuts = NativeModules.ZoltShortcuts as
  | { refresh(): Promise<void>; takeOpenDraft(): Promise<string | null> }
  | undefined;

/** Android: a share the app was opened with, as a new draft's id. Throws the reason it failed. */
export const takeIncomingShare = async () =>
  (await bridge?.takeIncoming?.(useLink.getState().mac?.macId ?? "")) ?? undefined;

/** The draft a Siri or Shortcuts action saved for the app to open, taken once. */
export const takeOpenDraft = async () =>
  (await shortcuts?.takeOpenDraft().catch(() => null)) ?? undefined;
export const sharingAvailable = Boolean(bridge);
export const useSharing = create<{
  drafts: SharedDraft[];
  error: string;
  refresh(): Promise<void>;
}>((set) => ({
  drafts: [],
  error: "",
  async refresh() {
    if (!bridge) return;
    try {
      set({ drafts: await bridge.listDrafts(), error: "" });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },
}));

export async function syncShareRecipients(expectedDirectory?: string) {
  if (!bridge) return;
  const { client, mac } = useLink.getState();
  const state = client?.getState();
  // An unpaired/sample app must remove any previous real directory. During reconnect,
  // retain the last directory until a complete snapshot is available.
  if (mac && state?.kind !== "fake" && !state?.loaded) return;
  const recipients =
    mac && state?.kind !== "fake" && state?.loaded
      ? shareRecipients(state.snapshot, mac.macId)
      : [];
  if (expectedDirectory !== undefined && JSON.stringify(recipients) !== expectedDirectory) return;
  await bridge.syncRecipients(recipients);
  await shortcuts?.refresh().catch(() => undefined);
}

export async function donateBotConversation(threadId: string) {
  if (!bridge) return;
  const { client, mac } = useLink.getState();
  const state = client?.getState();
  if (!mac || !state?.loaded || state.kind === "fake") return;
  const recipient = shareRecipients(state.snapshot, mac.macId).find(
    (row) => row.threadId === threadId,
  );
  if (recipient) {
    await syncShareRecipients();
    await bridge.donate(recipient);
  }
}

export async function updateSharedDraft(id: string, recipientId: string, message: string) {
  if (!bridge) throw new Error("Sharing needs a development or store build of the app.");
  await bridge.updateDraft(id, recipientId, message);
  await useSharing.getState().refresh();
}
export async function removeSharedDraft(id: string) {
  if (!bridge) throw new Error("Sharing needs a development or store build of the app.");
  await bridge.removeDraft(id);
  await useSharing.getState().refresh();
}

export async function markSharedDraftSent(id: string, threadId: string) {
  if (!bridge) throw new Error("Sharing needs a development or store build of the app.");
  await bridge.markDraftSent(id, threadId);
}

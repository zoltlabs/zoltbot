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
}
const bridge =
  Platform.OS === "ios" ? (NativeModules.ZoltShare as ShareBridge | undefined) : undefined;
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
  if (!bridge) throw new Error("Sharing requires an iOS development or production build.");
  await bridge.updateDraft(id, recipientId, message);
  await useSharing.getState().refresh();
}
export async function removeSharedDraft(id: string) {
  if (!bridge) throw new Error("Sharing requires an iOS development or production build.");
  await bridge.removeDraft(id);
  await useSharing.getState().refresh();
}

export async function markSharedDraftSent(id: string, threadId: string) {
  if (!bridge) throw new Error("Sharing requires an iOS development or production build.");
  await bridge.markDraftSent(id, threadId);
}

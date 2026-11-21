import { router } from "expo-router";
import { useEffect } from "react";
import { Alert, AppState } from "react-native";
import { shareRecipients } from "../data/sharing";
import { useClient, useLink } from "../state/link";
import {
  syncShareRecipients,
  takeIncomingShare,
  takeOpenDraft,
  useSharing,
} from "../state/sharing";

/**
 * Opens a draft that Siri or Shortcuts saved, if the link to it was lost on a cold start, or
 * (Android) one just shared to the app.
 */
const openSavedDraft = () => {
  void takeOpenDraft().then((id) => id && router.navigate(`/shared/${id}`));
  void takeIncomingShare().then(
    (id) => {
      if (!id) return;
      void useSharing.getState().refresh();
      router.navigate(`/shared/${id}`);
    },
    (error: unknown) =>
      Alert.alert(
        "Couldn’t save the share",
        error instanceof Error ? error.message : "Try sharing it again.",
      ),
  );
};

/** Syncs metadata. Foregrounding never sends drafts, and opens only one just made with Siri. */
export function SharingLifecycle() {
  const snapshot = useClient((state) => state.snapshot);
  const loaded = useClient((state) => state.loaded);
  const client = useLink((state) => state.client);
  const macId = useLink((state) => state.mac?.macId);
  useEffect(() => {
    void useSharing.getState().refresh();
    openSavedDraft();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void useSharing.getState().refresh();
        openSavedDraft();
        void syncShareRecipients().catch(() => undefined);
      }
    });
    return () => subscription.remove();
  }, []);
  const directory = JSON.stringify(shareRecipients(snapshot, macId ?? ""));
  useEffect(() => {
    if (macId && client && !loaded) return;
    // Coalesce streaming snapshot updates; the function reads the latest state.
    const timer = setTimeout(() => void syncShareRecipients(directory).catch(() => undefined), 200);
    return () => clearTimeout(timer);
  }, [directory, loaded, client, macId]);
  return null;
}

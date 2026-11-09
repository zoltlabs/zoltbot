import { useEffect } from "react";
import { AppState } from "react-native";
import { shareRecipients } from "../data/sharing";
import { useClient, useLink } from "../state/link";
import { syncShareRecipients, useSharing } from "../state/sharing";

/** Sync metadata only; foregrounding never sends drafts or interrupts navigation. */
export function SharingLifecycle() {
  const snapshot = useClient((state) => state.snapshot);
  const loaded = useClient((state) => state.loaded);
  const client = useLink((state) => state.client);
  const macId = useLink((state) => state.mac?.macId);
  useEffect(() => {
    void useSharing.getState().refresh();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void useSharing.getState().refresh();
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

import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { AppState, Platform } from "react-native";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { nativePhoneAccount } from "../cloud/native-account";
import { nativePhoneCloudConnection } from "../cloud/native-connection";
import { type CloudSessionState, phoneCloudSession } from "../cloud/session";
import { nativeDeviceIdentity } from "../data/native-link-store";
import { usePush } from "./push";

const configured = Boolean(process.env.EXPO_PUBLIC_ZOLTBOT_HOSTED_ORIGIN);
const settings = createStore<CloudSessionState>(() => ({
  checked: !configured,
  account: { configured, signedIn: false, online: false },
}));
export const cloudSession = phoneCloudSession({
  configured,
  account: nativePhoneAccount,
  connection: nativePhoneCloudConnection,
  identity: nativeDeviceIdentity,
  publish: (state) => settings.setState(state, true),
});
settings.setState(cloudSession.state(), true);
export const useCloud = <T>(select: (state: CloudSessionState) => T) => useStore(settings, select);

export function startCloud(): () => void {
  const stop = cloudSession.start();
  if (!configured) return stop;
  let active = true;
  let registeredFor: CloudSessionState["owner"];
  let last: string | null | undefined;
  let syncing = false;

  const syncPush = async () => {
    const { owner, cell } = cloudSession.state();
    if (Platform.OS !== "ios" || !owner || cell?.readOnly !== false || syncing || !active) return;
    const { token, label, busy } = usePush.getState();
    if (busy) return;
    // Leave an existing registration in place while the system cannot read a new token.
    const value = token ?? (label === "Denied" || label === "Not requested" ? null : undefined);
    if (value === undefined || (registeredFor === owner && last === value)) return;
    syncing = true;
    let confirmed = false;
    try {
      if (value === null) await nativePhoneAccount.clearPushToken(owner.sessionId, owner.deviceId);
      else {
        const entitlement = Constants.expoConfig?.ios?.entitlements?.["aps-environment"];
        const sandbox = entitlement === "development" || (entitlement !== "production" && __DEV__);
        await nativePhoneAccount.setPushToken(owner.sessionId, {
          deviceId: owner.deviceId,
          platform: sandbox ? "apns-sandbox" : "apns",
          token: value,
        });
      }
      if (active && cloudSession.state().owner === owner) {
        registeredFor = owner;
        last = value;
        confirmed = true;
      }
    } catch {
      // Retry on the next foreground refresh or confirmed connection.
    } finally {
      syncing = false;
      if (confirmed || cloudSession.state().owner !== owner) void syncPush();
    }
  };
  const refreshPush = () => {
    if (cloudSession.state().account.signedIn && Platform.OS === "ios")
      void usePush.getState().refresh().then(syncPush);
  };
  const stopSession = settings.subscribe((state, before) => {
    if (
      state.cell?.readOnly === false &&
      (before.owner !== state.owner || before.cell?.readOnly !== false)
    )
      refreshPush();
  });
  const stopPush = usePush.subscribe((state, before) => {
    if (before.busy && !state.busy) void syncPush();
  });
  const foreground = AppState.addEventListener("change", (state) => {
    if (state === "active") void cloudSession.refresh().then(refreshPush);
  });
  const tokenChanged =
    Platform.OS === "ios" ? Notifications.addPushTokenListener(refreshPush) : undefined;
  return () => {
    active = false;
    stopSession();
    stopPush();
    foreground.remove();
    tokenChanged?.remove();
    stop();
  };
}

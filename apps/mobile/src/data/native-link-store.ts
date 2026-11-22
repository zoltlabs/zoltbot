import type { Identity } from "@zoltbot/link";
import * as SecureStore from "expo-secure-store";
import { deviceIdentity, type SecretStore } from "./link-store";

/** The same device identity signs Local pairing and Cloud approvals. */
export const nativeLinkKeychain: SecretStore = {
  get: (key) => SecureStore.getItemAsync(key),
  set: (key, value) =>
    SecureStore.setItemAsync(key, value, {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    }),
  remove: (key) => SecureStore.deleteItemAsync(key),
};

let pending: Promise<Identity> | undefined;
export function nativeDeviceIdentity() {
  pending ??= deviceIdentity(nativeLinkKeychain).finally(() => {
    pending = undefined;
  });
  return pending;
}

import Constants from "expo-constants";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import { Platform } from "react-native";
import { phoneAccount } from "./account.js";

/** No operation runs at import. This singleton alone owns the phone's account session. */
export const nativePhoneAccount = phoneAccount({
  ...(process.env.EXPO_PUBLIC_ZOLTBOT_HOSTED_ORIGIN
    ? { origin: process.env.EXPO_PUBLIC_ZOLTBOT_HOSTED_ORIGIN }
    : {}),
  deviceName: Constants.deviceName ?? "Phone",
  storage: {
    get: (key) => SecureStore.getItemAsync(key),
    set: (key, value) =>
      SecureStore.setItemAsync(key, value, {
        keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
      }),
    remove: (key) => SecureStore.deleteItemAsync(key),
  },
  randomBytes: (size) => Crypto.getRandomBytesAsync(size),
  async challenge(verifier) {
    const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, {
      encoding: Crypto.CryptoEncoding.BASE64,
    });
    return digest.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  browser: {
    open(url, callback) {
      if (Platform.OS !== "ios" && Platform.OS !== "android")
        throw new Error("native_account_required");
      return WebBrowser.openAuthSessionAsync(url, callback);
    },
    cancel: () => WebBrowser.dismissAuthSession(),
  },
});

// P10: signs in to an app from the phone. The Mac builds the sign-in and keeps its secret; the
// phone's browser signs in and returns to the app, which hands the result back to the Mac.
import * as WebBrowser from "expo-web-browser";
import { Linking, Platform } from "react-native";
import { readRedirect, SIGN_IN_RETURN, type SignInCallback } from "../data/connection-sign-in";
import { useLink } from "./link";

const call = (method: string, params: unknown) =>
  useLink.getState().client?.getState().call(method, params) ??
  Promise.reject(new Error("Not connected to your Mac."));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One sign-in at a time: the browser and the Mac each allow only one. */
let signingIn = false;

/** Opens the sign-in and returns what came back, or undefined when the person closed it. */
async function browse(url: string): Promise<SignInCallback | undefined> {
  // On Android the return link can arrive just after the browser reports it was closed.
  let late: string | undefined;
  const listener = Linking.addEventListener("url", (event) => {
    if (event.url.startsWith(SIGN_IN_RETURN)) late = event.url;
  });
  try {
    const returned = await WebBrowser.openAuthSessionAsync(url, SIGN_IN_RETURN);
    if (returned.type === "success") return readRedirect(returned.url);
    if (Platform.OS === "android" && !late) await wait(600);
    return late ? readRedirect(late) : undefined;
  } finally {
    listener.remove();
  }
}

/** Signs `connectionId` in. Resolves false when the person closed or declined the sign-in. */
export async function signInOnPhone(connectionId: string): Promise<boolean> {
  if (signingIn) throw new Error("oauth_already_pending");
  signingIn = true;
  try {
    const attempt = (await call("connection.auth.startForPhone", {
      id: connectionId,
      confirmed: true,
    })) as { id: string; authorizationUrl: string };
    const status = async () =>
      ((await call("connection.auth.status", { id: attempt.id })) as { state: string }).state;
    try {
      const callback = await browse(attempt.authorizationUrl);
      if (!callback) {
        await call("connection.auth.cancel", { id: attempt.id }).catch(() => undefined);
        return false;
      }
      // The Mac checks it and, for an error, ends the attempt.
      const finished = call("connection.auth.finish", { id: attempt.id, ...callback });
      if (callback.error !== undefined) {
        await finished.catch(() => undefined);
        if (callback.error === "access_denied") return false;
        throw new Error("oauth_provider_error");
      }
      await finished;
      // The Mac redeems the code and stores the sign-in in its keychain.
      for (let tries = 0; tries < 30; tries++) {
        const state = await status();
        if (state === "connected") return true;
        if (state !== "waiting") throw new Error(`oauth_${state}`);
        await wait(1000);
      }
      throw new Error("oauth_timeout");
    } catch (error) {
      // Don't leave the Mac waiting; a sign-in that connected meanwhile still counts.
      if ((await status().catch(() => "")) === "connected") return true;
      await call("connection.auth.cancel", { id: attempt.id }).catch(() => undefined);
      throw error;
    }
  } finally {
    signingIn = false;
  }
}

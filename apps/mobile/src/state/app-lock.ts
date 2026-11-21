// P2: Face ID or the passcode to open the app. Kept on this phone, in the Keychain.
import * as LocalAuthentication from "expo-local-authentication";
import * as SecureStore from "expo-secure-store";
import { Alert, AppState, type NativeEventSubscription, NativeModules } from "react-native";
import { create } from "zustand";
import {
  defaultLockPrefs,
  type LockPrefs,
  type LockState,
  launchLock,
  nextLock,
  readLockPrefs,
  unlocked,
} from "../data/app-lock";

const KEY = "zoltbot.lock.v1";

/** The native cover (plugins/with-app-lock). Missing in Expo Go, where LockScreen stands in. */
interface LockBridge {
  setEnabled(on: boolean, afterSeconds: number): Promise<void>;
  lock(): Promise<"unlocked" | "no_passcode">;
}
export const nativeLock = NativeModules.ZoltLock as LockBridge | undefined;

interface AppLock extends LockState {
  /** False until the saved choice is read, so nothing shows before the lock can cover it. */
  ready: boolean;
  prefs: LockPrefs;
  /** Shows Face ID, or the passcode when Face ID isn't set up. */
  unlock(): Promise<boolean>;
  /** Turning it on or off checks Face ID first. */
  setPrefs(patch: Partial<LockPrefs>): Promise<"ok" | "unavailable" | "cancelled" | "failed">;
}

let checking: Promise<boolean> | undefined;
async function check(reason: string): Promise<boolean> {
  checking ??= LocalAuthentication.authenticateAsync({ promptMessage: reason })
    .then((result) => result.success)
    .catch(() => false)
    .finally(() => {
      checking = undefined;
    });
  return checking;
}

const save = (prefs: LockPrefs) =>
  SecureStore.setItemAsync(KEY, JSON.stringify(prefs), {
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  });

export const useAppLock = create<AppLock>((set, get) => ({
  ready: false,
  locked: false,
  covered: false,
  prefs: defaultLockPrefs,
  async unlock() {
    if (!get().locked) return true;
    if (nativeLock) return false; // The native cover asks for Face ID itself.
    const ok = await check("Unlock Zoltbot");
    if (ok) set(unlocked());
    return ok;
  },
  async setPrefs(patch) {
    const prefs = readLockPrefs({ ...get().prefs, ...patch });
    if (prefs.enabled !== get().prefs.enabled) {
      if (prefs.enabled) {
        const level = await LocalAuthentication.getEnrolledLevelAsync().catch(() => 0);
        if (level === LocalAuthentication.SecurityLevel.NONE) return "unavailable";
      }
      if (!(await check(prefs.enabled ? "Turn on the lock" : "Turn off the lock")))
        return "cancelled";
    }
    try {
      await save(prefs);
    } catch {
      return "failed";
    }
    set({ prefs, ...(prefs.enabled ? {} : unlocked()) });
    await nativeLock?.setEnabled(prefs.enabled, prefs.after).catch(() => undefined);
    return "ok";
  },
}));

/** The phone lost its passcode, so a lock would shut the owner out: turn it off and say so. */
async function noPasscode() {
  const prefs = { ...useAppLock.getState().prefs, enabled: false };
  useAppLock.setState({ prefs, ...unlocked() });
  await save(prefs).catch(() => undefined);
  Alert.alert("Lock turned off", "This phone has no screen lock, so Zoltbot can't lock.");
}

let lockingNatively = false;
function lockNatively() {
  if (!nativeLock || lockingNatively) return;
  lockingNatively = true;
  void nativeLock
    .lock()
    .then((outcome) => {
      if (outcome === "no_passcode") return noPasscode();
      useAppLock.setState(unlocked());
    })
    .catch(() => undefined)
    .finally(() => {
      lockingNatively = false;
    });
}

/** Reads the saved choice. A failed read locks, and is tried again when the app comes back. */
async function load(): Promise<boolean> {
  try {
    const saved = await SecureStore.getItemAsync(KEY);
    const prefs = saved === null ? defaultLockPrefs : readLockPrefs(JSON.parse(saved));
    const state = useAppLock.getState();
    // Still locked from a failed read: keep it until Face ID, unless the lock is off.
    const locked = prefs.enabled && (state.locked || launchLock(prefs).locked);
    useAppLock.setState({ prefs, locked, covered: locked, ready: true });
    await nativeLock?.setEnabled(prefs.enabled, prefs.after).catch(() => undefined);
    return true;
  } catch {
    useAppLock.setState({
      prefs: { ...defaultLockPrefs, enabled: true },
      ...launchLock({ ...defaultLockPrefs, enabled: true }),
      ready: true,
    });
    await nativeLock?.setEnabled(true, defaultLockPrefs.after).catch(() => undefined);
    return false;
  }
}

let subscription: NativeEventSubscription | undefined;
let loaded = false;
/** Locks on launch when the lock is on, and follows the app in and out. */
export function startAppLock(): void {
  if (subscription) return;
  useAppLock.subscribe((state, before) => {
    if (state.locked && !before.locked) lockNatively();
  });
  void load().then((ok) => {
    loaded = ok;
    if (useAppLock.getState().locked) lockNatively();
  });
  subscription = AppState.addEventListener("change", (phase) => {
    if (phase !== "active" && phase !== "inactive" && phase !== "background") return;
    const state = useAppLock.getState();
    if (!state.ready) return;
    if (phase === "active" && !loaded)
      void load().then((ok) => {
        loaded = ok;
      });
    const { locked, covered, leftAt } = nextLock(state, phase, state.prefs, Date.now());
    useAppLock.setState({ locked, covered, leftAt });
  });
}

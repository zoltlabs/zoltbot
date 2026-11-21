// P3: keeps the Lock Screen's Live Activity in step with the shown Mac while the app runs, and
// gives that Mac's relay the activity's push token so the Mac can update it while it's closed.
import { NativeModules, Platform } from "react-native";
import type { Client } from "../data/client";
import { type ActivityView, activityView, planActivity } from "../data/live-activity";
import { useAppLock } from "./app-lock";
import { relayOf, useLink } from "./link";

interface ActivityBridge {
  isAvailable(): Promise<boolean>;
  start(counts: object, top: object | null, macName: string): Promise<string | null>;
  update(counts: object, top: object | null): Promise<void>;
  end(): Promise<void>;
  pushToken(): Promise<string | null>;
}
const bridge =
  Platform.OS === "ios" ? (NativeModules.ZoltActivity as ActivityBridge | undefined) : undefined;

let running = false;
let shown: ActivityView | undefined;
/** The client whose Mac the running activity belongs to. */
let owner: Client | undefined;
let queue: Promise<unknown> = Promise.resolve();
/** The push token the owner's relay last got; iOS may rotate it while the activity runs. */
let registered: string | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;

/** With the app lock on, the Lock Screen shows counts only, never a request's title. */
const visible = (view: ActivityView): ActivityView =>
  useAppLock.getState().prefs.enabled ? { working: view.working, needsYou: view.needsYou } : view;

async function step(client: Client | undefined, macName: string) {
  if (!bridge) return;
  // Another Mac is shown now: its activity starts fresh, with its own push token.
  if (running && owner !== client) {
    await bridge.end().catch(() => undefined);
    running = false;
    shown = undefined;
    registered = undefined;
  }
  const enabled = !!client && (await bridge.isAvailable().catch(() => false));
  const next = visible(
    client ? activityView(client.getState().snapshot) : { working: 0, needsYou: 0 },
  );
  const plan = planActivity(running, shown, next, enabled);
  if (plan.kind === "none") return;
  if (plan.kind === "end") {
    await bridge.end().catch(() => undefined);
    running = false;
    shown = undefined;
    registered = undefined;
    return;
  }
  const counts = {
    working: plan.view.working,
    needsYou: plan.view.needsYou,
    topId: plan.view.top?.interactionId ?? null,
  };
  if (plan.kind === "update") {
    await bridge.update(counts, plan.view.top ?? null).catch(() => undefined);
    shown = plan.view;
    await registerToken(client);
    return;
  }
  try {
    await bridge.start(counts, plan.view.top ?? null, macName);
  } catch {
    return;
  }
  running = true;
  owner = client;
  shown = plan.view;
  registered = undefined;
  await registerToken(client);
}

/** Gives the Mac's relay the activity's current push token, again whenever iOS changes it. */
async function registerToken(client: Client | undefined) {
  const token = await bridge?.pushToken().catch(() => null);
  if (!token || token === registered) return;
  const relay = relayOf(client);
  if (!relay) return;
  // Development builds get their tokens from the APNs sandbox.
  relay.register("activity.register", __DEV__ ? "apns-sandbox" : "apns", token);
  registered = token;
}

function schedule() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = undefined;
    const { client, macName } = useLink.getState();
    queue = queue.then(() => step(client, macName)).catch(() => undefined);
  }, 1000);
}

let started = false;
/** Follows the shown Mac's snapshot; call once the link has booted. */
export function startLiveActivity(): void {
  if (started || !bridge) return;
  started = true;
  // One left from before the app was closed shows counts nobody keeps current now.
  queue = bridge.end().catch(() => undefined);
  let stopClient: (() => void) | undefined;
  const watch = (client: Client | undefined) => {
    stopClient?.();
    stopClient = client?.subscribe((state, before) => {
      if (state.snapshot !== before.snapshot) schedule();
    });
    schedule();
  };
  watch(useLink.getState().client);
  useLink.subscribe((state, before) => {
    if (state.client !== before.client) watch(state.client);
  });
  useAppLock.subscribe((state, before) => {
    if (state.prefs.enabled !== before.prefs.enabled) schedule();
  });
}

// P8: watches the agent's browser from the phone. Frames come only while a screen is open and
// the app is in front; leaving or backgrounding closes the view so the Mac stops sending.
import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import {
  readFrame,
  readState,
  SCREEN_CHECK_MS,
  SCREEN_RENEW_MS,
  type ScreenFrame,
  type ScreenInput,
  type ScreenState,
} from "../data/browser-screen";
import { useClient, useLink } from "./link";

const call = (method: string, params: unknown) =>
  useLink.getState().client?.getState().call(method, params) ??
  Promise.reject(new Error("Not connected to your Mac."));

function useActive() {
  const [active, setActive] = useState(AppState.currentState === "active");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (phase) =>
      setActive(phase === "active"),
    );
    return () => subscription.remove();
  }, []);
  return active;
}

/**
 * Open screens. Asking with `open:false` closes this phone's view, so the chat behind an open
 * screen doesn't ask.
 */
let screens = 0;

/** Whether the chat's agent has its browser open. Asks without opening a view. */
export function useBrowserRunning(threadId: string | undefined) {
  const online = useClient((state) => state.status === "online");
  const active = useActive();
  const [running, setRunning] = useState(false);
  useEffect(() => {
    if (!threadId || !online || !active) return;
    let live = true;
    const check = () =>
      screens > 0
        ? undefined
        : call("browser.view", { threadId, open: false })
            .then((value) => live && setRunning(readState(value).running))
            .catch(() => live && setRunning(false));
    void check();
    const timer = setInterval(check, SCREEN_CHECK_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [threadId, online, active]);
  return online && running;
}

/** The open screen: the latest frame, the browser's state, and input while in control. */
export function useBrowserScreen(threadId: string) {
  const client = useLink((state) => state.client);
  const online = useClient((state) => state.status === "online");
  const active = useActive();
  const [frame, setFrame] = useState<ScreenFrame>();
  const [state, setState] = useState<ScreenState>();
  const busy = useRef(false);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    if (!client || !online || !active) return;
    let live = true;
    screens++;
    const off = client.onNotify("browser.frame", (params) => {
      const next = readFrame(params, threadId);
      if (live && next) setFrame(next);
    });
    const view = (open: boolean) =>
      call("browser.view", { threadId, open }).then(
        (value) => {
          // A takeover in flight decides control itself.
          if (live && open && !busy.current) setState(readState(value));
        },
        () => undefined,
      );
    void view(true);
    const renew = setInterval(() => void view(true), SCREEN_RENEW_MS);
    return () => {
      live = false;
      screens--;
      off();
      clearInterval(renew);
      void view(false);
    };
  }, [client, online, active, threadId]);

  /** Takes control (the agent waits) or hands it back. Throws the Mac's refusal. */
  const takeover = async (control: boolean) => {
    busy.current = true;
    try {
      const value = (await call("browser.takeover", { threadId, control })) as {
        control?: boolean;
        url?: string | null;
      };
      setState((now) => ({
        running: now?.running ?? true,
        url: value.url ?? now?.url ?? null,
        control: value.control === true,
      }));
    } finally {
      busy.current = false;
    }
  };

  /** Sends input in order. A refused event drops the rest of that gesture, not the screen. */
  const send = (events: ScreenInput[]) => {
    for (const event of events)
      queue.current = queue.current
        .then(() => call("browser.input", { threadId, event }))
        .catch(() => undefined);
  };

  return { online, frame, state, takeover, send };
}

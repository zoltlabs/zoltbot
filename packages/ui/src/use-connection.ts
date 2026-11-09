import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { DaemonClient } from "./connection.js";
import { ConnectionSource } from "./connection-source.js";

export function useConnection() {
  const [source] = useState(
    () =>
      new ConnectionSource(
        () =>
          new DaemonClient(async () => {
            if (!window.zoltDesktop) throw new Error("Open the desktop app to connect.");
            return window.zoltDesktop.connection();
          }),
      ),
  );
  const state = useSyncExternalStore(source.subscribe, source.getSnapshot);
  useEffect(() => {
    source.connect();
    const stopBridge = window.zoltDesktop?.onConnectionChanged(() => source.connect());
    return () => {
      stopBridge?.();
      source.stop();
    };
  }, [source]);
  const call = useCallback(
    (method: string, params: unknown, commandId?: string) => source.call(method, params, commandId),
    [source],
  );
  return { ...state, call, onEvent: source.onEvent };
}

import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import TerminalPanel from "../../../packages/ui/src/chat/TerminalPanel.js";
import { type ConnectionState, DaemonClient } from "../../../packages/ui/src/connection.js";
import "../../../packages/ui/src/shell/shell.css";
function Preview() {
  const [visible, setVisible] = useState(true),
    [generation, setGeneration] = useState(0);
  const [state, setState] = useState<ConnectionState>({
    status: "connecting",
    snapshot: { seq: 0, entities: {}, counters: {} },
  });
  const client = useRef<DaemonClient>(undefined);
  useEffect(() => {
    void generation;
    const connection = new DaemonClient(async () =>
      (
        await fetch(new URL("../../../.cache/terminal-smoke/connection.json", import.meta.url).href)
      ).json(),
    );
    client.current = connection;
    const unsubscribe = connection.subscribe(setState);
    void connection.start();
    return () => {
      unsubscribe();
      connection.stop();
    };
  }, [generation]);
  return (
    <main>
      <h1>Synthetic server terminal</h1>
      <button type="button" onClick={() => setVisible((value) => !value)}>
        {visible ? "Hide view" : "Show view"}
      </button>
      <button type="button" onClick={() => setGeneration((value) => value + 1)}>
        Reconnect transport
      </button>
      <button
        type="button"
        onClick={() => {
          document.documentElement.dataset.theme =
            document.documentElement.dataset.theme === "dark" ? "light" : "dark";
        }}
      >
        Switch theme
      </button>
      {visible ? (
        <TerminalPanel
          threadId="thread"
          connection={{
            ...state,
            call: (...args) =>
              client.current ? client.current.call(...args) : Promise.reject(Error("offline")),
          }}
          onClose={() => setVisible(false)}
        />
      ) : null}
    </main>
  );
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<Preview />);

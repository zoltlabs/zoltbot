import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { TerminalInfo, TerminalOutput } from "@zoltbot/protocol";
import { useEffect, useRef, useState } from "react";
import { Button, IconButton } from "../components/primitives.js";
import type { ChatConnection } from "./types.js";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";

/** A disposable view: only terminal.close stops the server-owned shell. */
export default function TerminalPanel({
  connection,
  threadId,
  onClose,
}: {
  connection: ChatConnection;
  threadId: string;
  onClose(): void;
}) {
  const call = useRef(connection.call);
  call.current = connection.call;
  const host = useRef<HTMLElement>(null);
  const [terminal, setTerminal] = useState<TerminalInfo>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const terminalRef = useRef<TerminalInfo>(undefined);
  const createId = useRef(crypto.randomUUID());
  const inputQueue = useRef(Promise.resolve());
  const pendingInput = useRef(0);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    // A reconnect attempt deliberately reruns attachment setup.
    void attempt;
    let cancelled = false;
    setLoading(true);
    setError("");
    if (connection.status !== "online") {
      setLoading(false);
      return;
    }
    void call
      .current("terminal.list", { threadId })
      .then((result) => {
        if (cancelled) return;
        const items = (result as { items: TerminalInfo[] }).items;
        const selected = items.find((t) => t.status !== "exited") ?? items.at(-1);
        terminalRef.current = selected;
        setTerminal(selected);
      })
      .catch(() => {
        if (!cancelled) setError("The server workspace terminal is unavailable.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connection.status, threadId, attempt]);
  useEffect(() => {
    void attempt;
    if (!terminal?.id || !host.current || connection.status !== "online") return;
    let cancelled = false;
    let attachmentId: string | undefined;
    const id = terminal.id;
    const element = host.current;
    const css = getComputedStyle(element);
    const view = new Terminal({
      scrollback: 2000,
      screenReaderMode: true,
      fontSize: 13,
      fontFamily: css.getPropertyValue("--zb-font-mono"),
      theme: {
        background: css.getPropertyValue("--zb-bg-page").trim(),
        foreground: css.getPropertyValue("--zb-text").trim(),
        cursor: css.getPropertyValue("--zb-accent-text").trim(),
      },
    });
    const themeObserver = new MutationObserver(() => {
      const theme = getComputedStyle(element);
      view.options.theme = {
        background: theme.getPropertyValue("--zb-bg-page").trim(),
        foreground: theme.getPropertyValue("--zb-text").trim(),
        cursor: theme.getPropertyValue("--zb-accent-text").trim(),
      };
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    const fit = new FitAddon();
    view.loadAddon(fit);
    view.open(element);
    fit.fit();
    let live = false;
    const scope = { threadId, id };
    const input = view.onData((data) => {
      // Never send terminal replies while replaying retained history.
      if (!live || cancelled || terminalRef.current?.status !== "running") return;
      if (pendingInput.current + data.length > 32768) {
        setError("Terminal input is busy. Wait before pasting more text.");
        return;
      }
      pendingInput.current += data.length;
      inputQueue.current = inputQueue.current
        .then(async () => {
          for (let offset = 0; offset < data.length; ) {
            let end = Math.min(offset + 8192, data.length);
            if (end < data.length && /[\uD800-\uDBFF]/.test(data.charAt(end - 1))) end--;
            if (!cancelled)
              await call.current(
                "terminal.input",
                { ...scope, data: data.slice(offset, end) },
                crypto.randomUUID(),
              );
            offset = end;
          }
        })
        .catch(() => {
          if (!cancelled)
            setError("Input could not be confirmed. Check the terminal before typing again.");
        })
        .finally(() => {
          pendingInput.current -= data.length;
        });
    });
    let resizeTimer: ReturnType<typeof setTimeout>;
    const resize = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (cancelled) return;
        fit.fit();
        if (terminalRef.current?.status === "running")
          void call
            .current(
              "terminal.resize",
              {
                ...scope,
                cols: Math.min(500, Math.max(2, view.cols)),
                rows: Math.min(200, Math.max(1, view.rows)),
              },
              crypto.randomUUID(),
            )
            .catch(() => {});
      }, 100);
    });
    resize.observe(element);
    void (async () => {
      try {
        attachmentId = ((await call.current("terminal.attach", scope)) as { attachmentId: string })
          .attachmentId;
        if (cancelled) return;
        let offset = 0;
        while (!cancelled) {
          const output = (await call.current("terminal.read", {
            ...scope,
            attachmentId,
            offset,
          })) as TerminalOutput;
          if (cancelled) break;
          if (output.truncated) {
            live = false;
            view.reset();
            setError("Earlier output was discarded from the bounded server buffer.");
          }
          if (output.data) await new Promise<void>((resolve) => view.write(output.data, resolve));
          offset = output.offset;
          terminalRef.current = output.terminal;
          setTerminal(output.terminal);
          // Replay must finish before terminal replies can reach the live shell.
          if (output.caughtUp) live = true;
          if (output.terminal.status === "exited" && !output.data) break;
        }
      } catch {
        if (!cancelled)
          setError("Terminal connection lost. Reconnect to attach to the same shell.");
      } finally {
        if (attachmentId)
          void call.current("terminal.detach", { ...scope, attachmentId }).catch(() => {});
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(resizeTimer);
      resize.disconnect();
      themeObserver.disconnect();
      input.dispose();
      view.dispose();
      if (attachmentId)
        void call.current("terminal.detach", { ...scope, attachmentId }).catch(() => {});
    };
  }, [terminal?.id, connection.status, threadId, attempt]);
  const start = async () => {
    setStarting(true);
    setError("");
    try {
      const result = (await call.current(
        "terminal.create",
        { threadId, confirmed: true, cols: 80, rows: 20 },
        createId.current,
      )) as TerminalInfo;
      terminalRef.current = result;
      setTerminal(result);
    } catch {
      setError("Terminal could not be started. Retry uses the same creation request.");
    } finally {
      setStarting(false);
    }
  };
  return (
    <section className="terminal-panel" aria-label="Workspace terminal">
      <header className="terminal-toolbar">
        <strong>Terminal</strong>
        <output className="terminal-status">
          {connection.status !== "online"
            ? "Disconnected"
            : terminal?.status === "exited"
              ? `Exited (${terminal.exitCode ?? "unknown"})`
              : (terminal?.status ?? "")}
        </output>
        {terminal && terminal.status !== "exited" ? (
          <Button
            size="sm"
            disabled={stopping || connection.status !== "online"}
            onClick={() => {
              setStopping(true);
              void call
                .current("terminal.close", { threadId, id: terminal.id }, crypto.randomUUID())
                .catch(() => setError("Stopping could not be confirmed."))
                .finally(() => setStopping(false));
            }}
          >
            Stop shell
          </Button>
        ) : null}
        <IconButton
          icon="Rewind"
          label="Reconnect terminal"
          size="sm"
          disabled={loading || connection.status !== "online"}
          onClick={() => setAttempt((a) => a + 1)}
        />
        <IconButton icon="Close" label="Hide terminal" size="sm" onClick={onClose} />
      </header>
      {error ? (
        <p className="terminal-message" role="alert">
          {error}
        </p>
      ) : null}
      {!terminal && !loading ? (
        <div className="terminal-message">
          <p>
            Start a shell in this server workspace. Commands run with the server account’s access.
            Hiding this view keeps the shell running.
          </p>
          <Button
            size="sm"
            disabled={starting || connection.status !== "online"}
            onClick={() => void start()}
          >
            {starting ? "Starting…" : "Start shell"}
          </Button>
        </div>
      ) : null}
      <section ref={host} className="terminal-screen" aria-label="Terminal output and input" />
      {terminal?.status === "exited" ? (
        <Button
          size="sm"
          onClick={() => {
            createId.current = crypto.randomUUID();
            void start();
          }}
        >
          New shell
        </Button>
      ) : null}
    </section>
  );
}

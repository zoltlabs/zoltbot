import { parse, type ViewRecord, ViewRecordSchema } from "@zoltbot/protocol";
import { mapTopics } from "@zoltbot/view-api";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatConnection } from "../chat/types.js";
import { Button } from "../components/primitives.js";
import { useShell } from "../state.js";
import { ViewBridge, ViewCallError } from "./bridge.js";
import { viewKey } from "./keys.js";
import { viewTheme } from "./theme.js";
import "./views.css";
export default function ViewPage({ id, connection }: { id: string; connection: ChatConnection }) {
  const raw = connection.snapshot.entities.view?.find((row) => row.id === id);
  const record = raw ? parse(ViewRecordSchema, raw) : undefined;
  if (!record) return <p>View not found. Open Settings to reload your views.</p>;
  return <ViewFrame key={`${id}:${record.bundleHash}`} record={record} connection={connection} />;
}
function ViewFrame({ record, connection }: { record: ViewRecord; connection: ChatConnection }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const frame = useRef<HTMLIFrameElement>(null),
    bridge = useRef<ViewBridge | undefined>(undefined);
  const current = useRef(record);
  current.current = record;
  const [url, setUrl] = useState(""),
    [error, setError] = useState(""),
    [attempt, setAttempt] = useState(0);
  const data = useMemo(() => mapTopics(connection.snapshot), [connection.snapshot]);
  const currentConnection = useRef(connection);
  currentConnection.current = connection;
  const latestData = useRef(data);
  latestData.current = data;
  const granted = record.granted.includes("read");
  useEffect(() => {
    document.title = `${record.name} · Zoltbot`;
    heading.current?.focus();
  }, [record.name]);
  useEffect(() => {
    let active = true;
    void attempt;
    setUrl("");
    setError("");
    if (!granted || !record.enabled || !record.bundleHash) return;
    const prepare = window.zoltDesktop?.prepareView;
    if (!prepare) {
      setError("Open this view in the desktop app.");
      return;
    }
    void prepare(record.bundleHash)
      .then((result) => {
        if (active) setUrl(result.url);
      })
      .catch(() => {
        if (active) setError("View files are unavailable. Reload to try again.");
      });
    return () => {
      active = false;
      bridge.current?.close();
      bridge.current = undefined;
    };
  }, [attempt, granted, record.enabled, record.bundleHash]);
  useEffect(() => {
    bridge.current?.update(data);
  }, [data]);
  useEffect(() => {
    bridge.current?.event("grants", record.granted);
    if (!granted) bridge.current?.close();
  }, [record.granted, granted]);
  useEffect(() => {
    const timer = setInterval(() => bridge.current?.tick(), 100);
    const visibility = () => bridge.current?.visibility(!document.hidden);
    const theme = new MutationObserver(() => bridge.current?.event("theme", viewTheme()));
    theme.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "style"],
    });
    document.addEventListener("visibilitychange", visibility);
    return () => {
      clearInterval(timer);
      theme.disconnect();
      document.removeEventListener("visibilitychange", visibility);
      bridge.current?.close();
    };
  }, []);
  useEffect(() => {
    if (!url) return;
    const timer = setTimeout(() => {
      if (!bridge.current?.isConnected) setError("This view did not start");
    }, 10000);
    return () => clearTimeout(timer);
  }, [url]);
  function connect() {
    bridge.current?.close();
    const channel = new MessageChannel();
    const host = new ViewBridge({
      port: channel.port1,
      ready: () => ({
        t: "ready",
        api: 1,
        view: {
          id: current.current.id,
          name: current.current.name,
          version: current.current.version,
        },
        granted: current.current.granted,
        theme: viewTheme(),
        locale: navigator.language,
        reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
        mock: false,
      }),
      failed: () => setError("This view did not start"),
      key: viewKey,
      async call(method, params) {
        if (method !== "app.open")
          throw new ViewCallError("unavailable", "This call is not available yet.");
        const target = params as { chatId?: string; page?: string },
          shell = useShell.getState();
        if (target.chatId) {
          if (
            !currentConnection.current.snapshot.entities.thread?.some(
              (row) => row.id === target.chatId,
            )
          )
            throw new ViewCallError("not_found", "Chat not found.");
          shell.openThread(target.chatId);
        } else
          shell.navigate(
            target.page === "needs-you"
              ? "Inbox"
              : target.page === "settings"
                ? "Settings"
                : "Overview",
          );
      },
    });
    bridge.current = host;
    channel.port1.onmessage = (event) => host.receive(event.data);
    channel.port1.start();
    host.update(latestData.current);
    host.visibility(!document.hidden);
    frame.current?.contentWindow?.postMessage({ zolt: "connect", api: [1] }, "*", [channel.port2]);
  }
  return (
    <section className="view-page" aria-label={record.name}>
      <header className="view-header">
        <h1 ref={heading} tabIndex={-1}>
          {record.name}
        </h1>
        <Button
          onClick={() => {
            void connection
              .call("view.reload", {}, crypto.randomUUID())
              .then(() => setAttempt((n) => n + 1))
              .catch(() => setError("Could not reload this view."));
          }}
        >
          Reload
        </Button>
        <Button onClick={() => useShell.getState().navigate("Settings")}>Settings</Button>
      </header>
      {record.error ? (
        <p role="alert">
          {record.error.message}
          {record.error.path ? ` (${record.error.path})` : ""}
        </p>
      ) : null}
      {!record.enabled ? (
        <p>This view is disabled. Enable it in Settings.</p>
      ) : !granted ? (
        <p>
          This view needs permission to read your chats. Open Settings to manage its permissions.
        </p>
      ) : error ? (
        <div role="alert">
          <p>{error}</p>
          <Button onClick={() => setAttempt((n) => n + 1)}>Reload</Button>
          <Button onClick={() => useShell.getState().navigate("Settings")}>Open settings</Button>
        </div>
      ) : url ? (
        <iframe
          key={attempt}
          ref={frame}
          title={record.name}
          src={url}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          allow="autoplay; fullscreen 'none'; camera 'none'; microphone 'none'; geolocation 'none'"
          onLoad={connect}
          onError={() => setError("This view did not start")}
        />
      ) : (
        <output>Loading view…</output>
      )}
    </section>
  );
}

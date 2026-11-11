import { parse, type ViewRecord, ViewRecordSchema } from "@zoltbot/protocol";
import { mapTopics } from "@zoltbot/view-api";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatConnection } from "../chat/types.js";
import { Button } from "../components/primitives.js";
import { useShell } from "../state.js";
import { useAnswerConfirmation } from "./AnswerConfirmation.js";
import { viewActions } from "./actions.js";
import { ViewBridge } from "./bridge.js";
import { GrantDialog } from "./GrantDialog.js";
import { viewKey } from "./keys.js";
import { viewTheme } from "./theme.js";
import { ViewUpdate } from "./ViewUpdate.js";
import "./views.css";
export default function ViewPage({ id, connection }: { id: string; connection: ChatConnection }) {
  const raw = connection.snapshot.entities.view?.find((row) => row.id === id);
  const record = raw ? parse(ViewRecordSchema, raw) : undefined;
  if (record?.removed) return <p>This view was removed. Open Settings to import it again.</p>;
  if (!record) return <p>View not found. Open Settings to reload your views.</p>;
  return <ViewFrame key={`${id}:${record.bundleHash}`} record={record} connection={connection} />;
}
function ViewFrame({ record, connection }: { record: ViewRecord; connection: ChatConnection }) {
  const confirmation = useAnswerConfirmation();
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
  const [dismissed, setDismissed] = useState("");
  const requestedKey = record.requested.join(",");
  const missing = record.requested.filter(
    (permission) =>
      !record.granted.includes(permission) && !(record.reviewed ?? []).includes(permission),
  );
  if (!granted && !missing.includes("read")) missing.unshift("read");
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
    const shortcut = (event: Event) => {
      const detail = (event as CustomEvent<{ viewId: string; shortcutId: string }>).detail;
      const view = current.current;
      if (
        detail?.viewId === view.id &&
        view.enabled &&
        view.granted.includes("read") &&
        view.shortcuts?.some((row) => row.id === detail.shortcutId)
      ) {
        bridge.current?.event("shortcut", detail.shortcutId);
        frame.current?.focus();
      }
    };
    window.addEventListener("view-shortcut", shortcut);
    return () => window.removeEventListener("view-shortcut", shortcut);
  }, []);
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
      call: viewActions({
        record: () => current.current,
        snapshot: () => currentConnection.current.snapshot,
        call: (method, params, commandId) =>
          currentConnection.current.call(method, params, commandId),
        confirm: confirmation.confirm,
        open(target) {
          const shell = useShell.getState();
          if (target.chatId) shell.openThread(target.chatId);
          else
            shell.navigate(
              target.page === "needs-you"
                ? "Inbox"
                : target.page === "settings"
                  ? "Settings"
                  : "Overview",
            );
        },
      }),
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
      {confirmation.dialog}
      <GrantDialog
        record={record}
        connection={connection}
        offered={missing}
        fresh
        open={
          record.enabled && !!record.bundleHash && missing.length > 0 && dismissed !== requestedKey
        }
        onClose={() => setDismissed(requestedKey)}
      />
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
        <Button onClick={() => useShell.getState().navigate("ViewsSettings")}>Settings</Button>
      </header>
      <ViewUpdate record={record} connection={connection} />
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
          <Button onClick={() => useShell.getState().navigate("ViewsSettings")}>
            Open settings
          </Button>
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

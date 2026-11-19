import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import type { ViewHostEvent, ViewPermission, ViewSummary, ViewTheme } from "../../../shared/ipc";
import { SidebarToggleIcon } from "./Sidebar";
import { GrantCard, PermissionsMenu, shortcutFor } from "./ViewGrants";

interface MapViewProps {
  sidebarCollapsed: boolean;
  onShowSidebar: () => void;
  onToggleSidebar: () => void;
  /** The map asked to open a chat, or another page when `chatId` is null. */
  onOpenChat: (chatId: string | null) => void;
}

/** The look the view copies: the Zoltbot tokens views are built against, in the shell's dark. */
function viewTheme(): ViewTheme {
  const style = getComputedStyle(document.documentElement);
  const tokens: Record<string, string> = {};
  for (const name of Array.from(style))
    if (name.startsWith("--zb-") && !/^--zb-(?:gray-|indigo-|ink$)/.test(name))
      tokens[name] = style.getPropertyValue(name).trim();
  return {
    scheme: "dark",
    tokens,
    fontSans: style.getPropertyValue("--zb-font-sans").trim(),
    fontMono: style.getPropertyValue("--zb-font-mono").trim(),
    fontScale: Number(style.getPropertyValue("--zb-font-scale")) || 1,
  };
}

/**
 * Shows the command map view in place of the conversation. The frame and its MessageChannel live
 * here; main checks and answers every message the view sends.
 */
export function MapView(props: MapViewProps) {
  const views = window.openbot.views;
  const [view, setView] = createSignal<ViewSummary | null>(null);
  const [loaded, setLoaded] = createSignal(false);
  const [url, setUrl] = createSignal("");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [grantError, setGrantError] = createSignal("");
  const [attempt, setAttempt] = createSignal(0);
  let frame: HTMLIFrameElement | undefined;
  let session: { id: string; port: MessagePort } | undefined;
  let connecting = 0;

  const usableId = createMemo(() => {
    const current = view();
    return current?.enabled && current.canRead ? current.id : "";
  });
  /** What the grant card asks about; it starts over whenever this changes. */
  const pendingKey = createMemo(() => {
    const current = view();
    return current?.enabled && !current.error && current.pending.length
      ? `${current.id}:${current.pending.join()}:${current.granted.join()}`
      : "";
  });

  function refresh() {
    void views
      .getMap()
      .then(setView)
      .catch(() => setError("Zoltbot isn't running."))
      .finally(() => setLoaded(true));
  }

  function disconnect() {
    connecting++;
    if (!session) return;
    session.port.close();
    views.close(session.id);
    session = undefined;
  }

  async function connect() {
    disconnect();
    const viewId = usableId();
    const target = frame?.contentWindow;
    if (!viewId || !target) return;
    const token = connecting;
    try {
      const { sessionId } = await views.connect({
        viewId,
        theme: viewTheme(),
        locale: navigator.language,
        reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      });
      if (token !== connecting || frame?.contentWindow !== target) {
        views.close(sessionId);
        return;
      }
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => views.post(sessionId, event.data);
      session = { id: sessionId, port: channel.port1 };
      views.update({ sessionId, visible: !document.hidden });
      target.postMessage({ zolt: "connect", api: [1] }, "*", [channel.port2]);
    } catch {
      if (token === connecting) setError("The map didn't start.");
    }
  }

  function handleEvent(event: ViewHostEvent) {
    if (event.type === "views-changed") refresh();
    else if (event.type === "message") {
      if (session?.id === event.sessionId) session.port.postMessage(event.message);
    } else if (event.type === "closed") {
      if (session?.id !== event.sessionId) return;
      session.port.close();
      session = undefined;
      if (event.failed) setError("The map stopped responding.");
      else setAttempt((value) => value + 1);
    } else if (event.type === "open") props.onOpenChat(event.chatId);
    else if (event.type === "key") {
      if (event.combo === "mod+b") props.onToggleSidebar();
      if (event.combo === "escape-exit") {
        if (props.sidebarCollapsed) props.onShowSidebar();
        queueMicrotask(() => document.querySelector<HTMLElement>(".sidebar-map-button")?.focus());
      }
    }
  }

  createEffect(
    on([usableId, attempt], ([viewId]) => {
      disconnect();
      setUrl("");
      setError("");
      if (!viewId) return;
      let active = true;
      void views
        .prepare(viewId)
        .then((result) => {
          if (active) setUrl(result.url);
        })
        .catch(() => {
          if (active) setError("The map's files are unavailable.");
        });
      onCleanup(() => {
        active = false;
      });
    }),
  );

  onMount(() => {
    const unsubscribe = views.onEvent(handleEvent);
    const visibility = () => {
      if (session) views.update({ sessionId: session.id, visible: !document.hidden });
    };
    // Keys pressed inside the frame go to the view itself; this covers focus in the shell.
    const keydown = (event: KeyboardEvent) => {
      const current = view();
      if (!session || !current) return;
      const shortcut = shortcutFor(current.shortcuts, event);
      if (!shortcut) return;
      event.preventDefault();
      views.shortcut(session.id, shortcut.id);
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("keydown", keydown);
    refresh();
    onCleanup(() => {
      unsubscribe();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("keydown", keydown);
      disconnect();
    });
  });

  function run(action: (viewId: string) => Promise<void>) {
    const current = view();
    if (!current || busy()) return;
    setBusy(true);
    setError("");
    void action(current.id)
      .catch(() => setError("Zoltbot couldn't change the map. Try again."))
      .finally(() => setBusy(false));
  }

  function saveGrants(permissions: ViewPermission[]) {
    const current = view();
    if (!current || busy()) return;
    setBusy(true);
    setGrantError("");
    void views
      .setGrants(current.id, permissions)
      .then(refresh)
      .catch(() => setGrantError("Zoltbot couldn't save these permissions. Try again."))
      .finally(() => setBusy(false));
  }

  const grantCard = (current: ViewSummary) => (
    <Show when={pendingKey()} keyed>
      <GrantCard
        name={current.name}
        pending={current.pending}
        granted={current.granted}
        busy={busy()}
        error={grantError()}
        onSave={saveGrants}
      />
    </Show>
  );

  // The conversation's <main> is inert while the map covers it, so the map is the main landmark.
  return (
    <main aria-label="Map" class="map-panel">
      <header class="window-drag map-header">
        <Show when={props.sidebarCollapsed}>
          <button
            type="button"
            class="sidebar-icon-button sidebar-restore-button no-drag"
            aria-label="Show sidebar"
            aria-controls="bot-sidebar"
            aria-expanded="false"
            title="Show sidebar"
            onClick={props.onShowSidebar}
          >
            <SidebarToggleIcon />
          </button>
        </Show>
        <h1 class="map-title">{view()?.name ?? "Map"}</h1>
        <Show when={view()?.enabled && view()?.requested.length ? view() : null}>
          {(current) => (
            <PermissionsMenu
              name={current().name}
              requested={current().requested}
              granted={current().granted}
              busy={busy()}
              error={grantError()}
              onSave={saveGrants}
            />
          )}
        </Show>
      </header>
      <div class="map-body">
        <Show when={loaded()}>
          <Show
            when={view()}
            fallback={<p class="map-message">The command map isn't installed.</p>}
          >
            {(current) => (
              <Show
                when={!error() && !current().error && usableId()}
                fallback={
                  <div class="map-message" role={error() || current().error ? "alert" : undefined}>
                    <Show
                      when={error() || current().error}
                      fallback={
                        <Show
                          when={current().enabled}
                          fallback={
                            <>
                              <p>The map is turned off.</p>
                              <button
                                type="button"
                                class="map-action"
                                disabled={busy()}
                                onClick={() => run(views.turnOn)}
                              >
                                Turn on
                              </button>
                            </>
                          }
                        >
                          {grantCard(current())}
                        </Show>
                      }
                    >
                      {(message) => (
                        <>
                          <p>{message()}</p>
                          <button
                            type="button"
                            class="map-action"
                            onClick={() => {
                              setError("");
                              setAttempt((value) => value + 1);
                              refresh();
                            }}
                          >
                            Try again
                          </button>
                        </>
                      )}
                    </Show>
                  </div>
                }
              >
                <Show
                  when={url()}
                  keyed
                  fallback={<output class="map-loading" aria-label="Loading the map" />}
                >
                  {(src) => (
                    <>
                      <iframe
                        ref={frame}
                        class="map-frame"
                        title={current().name}
                        src={src}
                        sandbox="allow-scripts"
                        referrerpolicy="no-referrer"
                        allow="autoplay; fullscreen 'none'; camera 'none'; microphone 'none'; geolocation 'none'"
                        onLoad={() => void connect()}
                      />
                      <Show when={pendingKey()}>
                        <div class="map-grant-overlay">{grantCard(current())}</div>
                      </Show>
                    </>
                  )}
                </Show>
              </Show>
            )}
          </Show>
        </Show>
      </div>
    </main>
  );
}

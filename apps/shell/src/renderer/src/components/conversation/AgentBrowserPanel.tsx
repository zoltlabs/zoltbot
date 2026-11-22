// B2: the agent's own browser, live, beside the chat. B3: the owner can take it over.
// M7: the owner can teach a task by doing it here; Done sends the recording to the agent.
import { createEffect, createSignal, on, onCleanup, Show } from "solid-js";
import { AGENT_BROWSER_RENEW_MS, type AgentBrowserFrame } from "../../../../shared/agent-browser";
import {
  type AgentBrowserInput,
  canvasToPage,
  mouseButton,
  pageKey,
} from "../../../../shared/agent-browser-input";
import { t } from "../../i18n";
import { PanelResizer } from "../PanelResizer";
import "../../agent-browser.css";
import {
  BROWSER_PANEL_DEFAULT,
  BROWSER_PANEL_MAX,
  BROWSER_PANEL_MIN,
  CONVERSATION_PANEL_MIN,
} from "./constants";
import { CloseIcon } from "./icons";

export function AgentBrowserPanel(props: {
  threadId: string | null;
  agentName: string;
  width: number;
  containerWidth: () => number;
  onResize: (width: number) => void;
  onResizeEnd: (width: number) => void;
  onClose: () => void;
}) {
  const [frame, setFrame] = createSignal<AgentBrowserFrame>();
  const [url, setUrl] = createSignal<string | null>(null);
  const [running, setRunning] = createSignal(false);
  const [control, setControl] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const [announce, setAnnounce] = createSignal("");
  const [cookies, setCookies] = createSignal<{ site: string; accept: boolean } | null>(null);
  const [savingCookies, setSavingCookies] = createSignal(false);
  const [cookiesFailed, setCookiesFailed] = createSignal(false);
  const [teach, setTeach] = createSignal<number | null>(null);
  const [teachFailed, setTeachFailed] = createSignal<"start" | "done" | "cancel" | null>(null);
  let takeButton: HTMLButtonElement | undefined;
  let teachButton: HTMLButtonElement | undefined;
  let doneButton: HTMLButtonElement | undefined;
  let closeButton: HTMLButtonElement | undefined;
  let handButton: HTMLButtonElement | undefined;
  let lastEscape = 0;
  let canvas: HTMLCanvasElement | undefined;
  let drawing = 0;

  // Switching chats switches the viewed browser.
  createEffect(
    on(
      () => props.threadId,
      (threadId) => {
        setFrame(undefined);
        setUrl(null);
        setRunning(false);
        setControl(false);
        setFailed(false);
        setAnnounce("");
        setCookies(null);
        setCookiesFailed(false);
        setTeach(null);
        setTeachFailed(null);
        if (!threadId) return;
        const view = (open: boolean) =>
          window.openbot.agentBrowser
            .view({ threadId, open })
            .then((state) => {
              if (!open) return;
              if (state.url) setUrl((current) => current ?? state.url);
              setRunning(state.running);
              if (!savingCookies()) setCookies(state.cookies ?? null);
              if (!busy()) {
                const next = state.teach?.steps ?? null;
                // Teaching ended elsewhere (the card in the chat, the phone): nothing was kept.
                if (next === null && teach() !== null)
                  setAnnounce(t("browser.teach.stopped", { agent: props.agentName }));
                setTeach(next);
              }
              // The card can be answered elsewhere (Needs you, the phone).
              if (!busy() && control() !== state.control) {
                setControl(state.control);
                if (!state.control)
                  setAnnounce(t("browser.view.handedBack", { agent: props.agentName }));
              }
            })
            .catch(() => undefined);
        void view(true);
        const renew = setInterval(() => void view(true), AGENT_BROWSER_RENEW_MS);
        // While recording, the step count keeps up with the owner.
        const count = setInterval(() => teach() !== null && void view(true), 1_000);
        onCleanup(() => clearInterval(count));
        const off = window.openbot.agentBrowser.onFrame((next) => {
          if (next.threadId !== threadId) return;
          setUrl(next.url);
          void draw(next);
        });
        onCleanup(() => {
          // Closing the panel or switching chats mid-recording cancels it, so the agent isn't stuck.
          if (teach() !== null)
            void window.openbot.agentBrowser.teach({ threadId, action: "cancel" }).catch(() => {});
          clearInterval(renew);
          off();
          void view(false);
        });
      },
    ),
  );

  async function draw(next: AgentBrowserFrame) {
    const ticket = ++drawing;
    const bytes = Uint8Array.from(atob(next.data), (c) => c.charCodeAt(0));
    const image = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" })).catch(
      () => undefined,
    );
    if (!image) return;
    // A newer frame already drew.
    if (ticket !== drawing) return image.close();
    setFrame(next);
    if (canvas) {
      canvas.width = image.width;
      canvas.height = image.height;
      canvas.getContext("2d")?.drawImage(image, 0, 0);
    }
    image.close();
  }

  async function setTakeover(next: boolean) {
    const threadId = props.threadId;
    if (!threadId || busy()) return;
    setBusy(true);
    setFailed(false);
    try {
      const result = await window.openbot.agentBrowser.takeover({ threadId, control: next });
      setControl(result.control);
      setAnnounce(
        result.control
          ? t("browser.view.inControl")
          : t("browser.view.handedBack", { agent: props.agentName }),
      );
      // The button that was pressed is gone; keep focus somewhere useful.
      requestAnimationFrame(() => (result.control ? canvas : takeButton)?.focus());
    } catch {
      if (next) setFailed(true);
      else setControl(false);
    } finally {
      setBusy(false);
    }
  }

  // M7: Teach takes control and records; Done or Cancel hands the browser back.
  async function teachAction(action: "start" | "done" | "cancel") {
    const threadId = props.threadId;
    if (!threadId || busy()) return;
    setBusy(true);
    setTeachFailed(null);
    setFailed(false);
    try {
      const result = await window.openbot.agentBrowser.teach({ threadId, action });
      if (action === "start") {
        setControl(true);
        setTeach(result.steps);
        setAnnounce(t("browser.teach.started"));
      } else {
        setControl(false);
        setTeach(null);
        setAnnounce(
          t(result.sent ? "browser.teach.sent" : "browser.teach.stopped", {
            agent: props.agentName,
          }),
        );
      }
      requestAnimationFrame(() =>
        (action === "start" ? canvas : (teachButton ?? closeButton))?.focus(),
      );
    } catch {
      setTeachFailed(action);
    } finally {
      setBusy(false);
    }
  }

  // B5: the owner flips what the browser does with cookie banners on this site.
  async function flipCookies() {
    const current = cookies();
    if (!current || savingCookies()) return;
    const next = { site: current.site, accept: !current.accept };
    setSavingCookies(true);
    setCookiesFailed(false);
    setAnnounce("");
    try {
      await window.openbot.agentBrowser.cookies(next);
      setCookies(next);
      setAnnounce(
        t(next.accept ? "browser.cookies.nowAccepted" : "browser.cookies.nowRejected", {
          site: next.site,
        }),
      );
    } catch {
      setCookiesFailed(true);
    } finally {
      setSavingCookies(false);
    }
  }

  // B3: while in control, the owner's mouse and keys go to the page. Nothing here is logged.
  let moving: AgentBrowserInput | undefined;
  let movePending = false;
  function send(event: AgentBrowserInput) {
    const threadId = props.threadId;
    if (!threadId || !control()) return;
    void window.openbot.agentBrowser.input({ threadId, event }).catch(() => undefined);
  }
  function at(event: { clientX: number; clientY: number }) {
    const current = frame();
    if (!canvas || !current) return undefined;
    const box = canvas.getBoundingClientRect();
    return canvasToPage(
      { x: event.clientX - box.left, y: event.clientY - box.top },
      { width: box.width, height: box.height },
      { width: current.width, height: current.height },
    );
  }
  function mouse(type: "move" | "down" | "up", event: PointerEvent) {
    if (!control()) return;
    const point = at(event);
    if (!point) return;
    if (type !== "move") {
      if (type === "down") canvas?.focus();
      send({ kind: "mouse", type, ...point, button: mouseButton(event.button) });
      return;
    }
    // One move per frame is enough.
    moving = { kind: "mouse", type: "move", ...point };
    if (movePending) return;
    movePending = true;
    requestAnimationFrame(() => {
      movePending = false;
      if (moving) send(moving);
      moving = undefined;
    });
  }
  function wheel(event: WheelEvent) {
    if (!control()) return;
    const point = at(event);
    if (!point) return;
    event.preventDefault();
    send({ kind: "mouse", type: "wheel", ...point, deltaX: event.deltaX, deltaY: event.deltaY });
  }
  function key(type: "down" | "up", event: KeyboardEvent) {
    if (!control()) return;
    // Esc twice leaves the page for the panel; the first one still reaches the page.
    if (event.key === "Escape" && type === "down") {
      const now = Date.now();
      if (now - lastEscape < 600) {
        lastEscape = 0;
        event.preventDefault();
        (teach() !== null ? doneButton : handButton)?.focus();
        return;
      }
      lastEscape = now;
    }
    const value = pageKey(event);
    if (!value) return;
    event.preventDefault();
    send({ kind: "key", type, key: value });
  }

  const pointer = () => {
    const current = frame();
    if (control() || !current?.pointer) return undefined;
    return {
      left: `${(current.pointer.x / current.width) * 100}%`,
      top: `${(current.pointer.y / current.height) * 100}%`,
    };
  };

  return (
    <aside
      id="browser-side-panel"
      class="browser-panel agent-browser-panel"
      aria-label={t("browser.view.title")}
    >
      <PanelResizer
        class="right-panel-resizer"
        label={t("browser.view.resize")}
        controls="browser-side-panel"
        direction="right"
        value={props.width}
        defaultValue={BROWSER_PANEL_DEFAULT}
        min={BROWSER_PANEL_MIN}
        max={() =>
          Math.min(
            BROWSER_PANEL_MAX,
            Math.max(BROWSER_PANEL_MIN, props.containerWidth() - CONVERSATION_PANEL_MIN),
          )
        }
        onResize={props.onResize}
        onResizeEnd={props.onResizeEnd}
      />
      <header class="agent-browser-header">
        <h2>{t("browser.view.title")}</h2>
        <div class="agent-browser-control">
          <Show when={teach() === null}>
            <Show
              when={control()}
              fallback={
                <Show when={running()}>
                  <button
                    ref={teachButton}
                    type="button"
                    class="zb-kit-button agent-browser-control-button"
                    aria-describedby="agent-browser-teach-hint"
                    title={t("browser.teach.hint", { agent: props.agentName })}
                    disabled={busy()}
                    onClick={() => void teachAction("start")}
                  >
                    {t("browser.teach.start")}
                  </button>
                  <span id="agent-browser-teach-hint" class="sr-only">
                    {t("browser.teach.hint", { agent: props.agentName })}
                  </span>
                  <button
                    ref={takeButton}
                    type="button"
                    class="zb-kit-button agent-browser-control-button"
                    disabled={busy()}
                    onClick={() => void setTakeover(true)}
                  >
                    {t("browser.view.takeOver")}
                  </button>
                </Show>
              }
            >
              <span class="agent-browser-control-status" aria-hidden="true">
                {t("browser.view.inControl")}
              </span>
              <button
                ref={handButton}
                type="button"
                class="zb-kit-button primary agent-browser-control-button"
                disabled={busy()}
                onClick={() => void setTakeover(false)}
              >
                {t("browser.view.handBack")}
              </button>
            </Show>
          </Show>
        </div>
        <button
          ref={closeButton}
          type="button"
          class="agent-settings-nav-button"
          aria-label={t("browser.view.close")}
          onClick={() => props.onClose()}
        >
          <CloseIcon />
        </button>
      </header>
      <Show when={teach() !== null}>
        <div class="agent-browser-teachbar">
          <span
            id="agent-browser-recording"
            class="agent-browser-control-status agent-browser-recording"
          >
            {t("browser.teach.recording", { count: teach() ?? 0 })}
          </span>
          <button
            type="button"
            class="zb-kit-button agent-browser-control-button"
            disabled={busy()}
            onClick={() => void teachAction("cancel")}
          >
            {t("browser.teach.cancel")}
          </button>
          <button
            ref={doneButton}
            type="button"
            class="zb-kit-button primary agent-browser-control-button"
            aria-describedby="agent-browser-recording"
            disabled={busy() || !teach()}
            onClick={() => void teachAction("done")}
          >
            {t("browser.teach.done")}
          </button>
        </div>
      </Show>
      <p class="sr-only" aria-live="polite">
        {announce()}
      </p>
      <Show when={failed()}>
        <p class="agent-browser-error" role="alert">
          {t("browser.view.takeOverFailed")}
        </p>
      </Show>
      <Show when={teachFailed()}>
        {(which) => (
          <p class="agent-browser-error" role="alert">
            {t(
              which() === "start"
                ? "browser.teach.startFailed"
                : which() === "done"
                  ? "browser.teach.doneFailed"
                  : "browser.teach.cancelFailed",
              { agent: props.agentName },
            )}
          </p>
        )}
      </Show>
      <Show
        when={url()}
        fallback={
          <p class="agent-browser-empty">{t("browser.view.empty", { agent: props.agentName })}</p>
        }
      >
        {(address) => (
          <div class="agent-browser-address" title={address()}>
            <span class="agent-browser-address-text">{address()}</span>
          </div>
        )}
      </Show>
      <Show when={cookies()}>
        {(state) => (
          <div class="agent-browser-cookies">
            <span id="agent-browser-cookies-text" class="agent-browser-cookies-text">
              {t(state().accept ? "browser.cookies.accepted" : "browser.cookies.rejected", {
                site: state().site,
              })}
            </span>
            <button
              type="button"
              class="agent-browser-cookies-flip"
              aria-describedby="agent-browser-cookies-text"
              aria-disabled={savingCookies()}
              onClick={() => void flipCookies()}
            >
              {t(state().accept ? "browser.cookies.reject" : "browser.cookies.accept")}
            </button>
          </div>
        )}
      </Show>
      <Show when={cookiesFailed()}>
        <p class="agent-browser-error" role="alert">
          {t("browser.cookies.failed")}
        </p>
      </Show>
      <div
        class="agent-browser-stage"
        classList={{
          "agent-browser-stage-ready": Boolean(frame()),
          "agent-browser-stage-control": control(),
          "agent-browser-stage-teach": teach() !== null,
        }}
      >
        <div class="agent-browser-screen">
          <canvas
            ref={canvas}
            role={control() ? "application" : "img"}
            tabIndex={control() ? 0 : -1}
            aria-label={t("browser.view.screen", { agent: props.agentName })}
            aria-describedby={
              teach() !== null
                ? "agent-browser-teaching agent-browser-leave"
                : control()
                  ? "agent-browser-leave"
                  : undefined
            }
            onPointerDown={(event) => mouse("down", event)}
            onPointerUp={(event) => mouse("up", event)}
            onPointerMove={(event) => mouse("move", event)}
            onWheel={wheel}
            onKeyDown={(event) => key("down", event)}
            onKeyUp={(event) => key("up", event)}
            onContextMenu={(event) => control() && event.preventDefault()}
          />
          <span id="agent-browser-teaching" class="sr-only">
            {t("browser.teach.started")}
          </span>
          <span id="agent-browser-leave" class="sr-only">
            {t("browser.view.leave")}
          </span>
          <Show when={pointer()}>
            {(at) => (
              <span
                class="agent-browser-pointer"
                aria-hidden="true"
                style={{ left: at().left, top: at().top }}
              />
            )}
          </Show>
        </div>
      </div>
    </aside>
  );
}

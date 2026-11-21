// B2: the agent's own browser, live, beside the chat.
import { createEffect, createSignal, on, onCleanup, Show } from "solid-js";
import { AGENT_BROWSER_RENEW_MS, type AgentBrowserFrame } from "../../../../shared/agent-browser";
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
  let canvas: HTMLCanvasElement | undefined;
  let drawing = 0;

  // Switching chats switches the viewed browser.
  createEffect(
    on(
      () => props.threadId,
      (threadId) => {
        setFrame(undefined);
        setUrl(null);
        if (!threadId) return;
        const view = (open: boolean) =>
          window.openbot.agentBrowser
            .view({ threadId, open })
            .then((state) => open && state.url && setUrl((current) => current ?? state.url))
            .catch(() => undefined);
        void view(true);
        const renew = setInterval(() => void view(true), AGENT_BROWSER_RENEW_MS);
        const off = window.openbot.agentBrowser.onFrame((next) => {
          if (next.threadId !== threadId) return;
          setUrl(next.url);
          void draw(next);
        });
        onCleanup(() => {
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

  const pointer = () => {
    const current = frame();
    if (!current?.pointer) return undefined;
    return {
      left: `${(current.pointer.x / current.width) * 100}%`,
      top: `${(current.pointer.y / current.height) * 100}%`,
    };
  };

  return (
    <aside id="browser-side-panel" class="browser-panel agent-browser-panel" aria-label={t("browser.view.title")}>
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
        <button
          type="button"
          class="agent-settings-nav-button"
          aria-label={t("browser.view.close")}
          onClick={() => props.onClose()}
        >
          <CloseIcon />
        </button>
      </header>
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
      <div class="agent-browser-stage" classList={{ "agent-browser-stage-ready": Boolean(frame()) }}>
        <div class="agent-browser-screen">
          <canvas
            ref={canvas}
            role="img"
            aria-label={t("browser.view.screen", { agent: props.agentName })}
          />
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

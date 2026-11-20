import { For, Show } from "solid-js";
import { PanelResizer } from "../PanelResizer";
import type { BrowserState } from "./browser-state";
import {
  BROWSER_ACTION_LABELS,
  BROWSER_PANEL_DEFAULT,
  BROWSER_PANEL_MAX,
  BROWSER_PANEL_MIN,
  CONVERSATION_PANEL_MIN,
} from "./constants";
import {
  BrowserBackIcon,
  BrowserControlIcon,
  BrowserForwardIcon,
  BrowserReloadIcon,
  CloseIcon,
  PlusIcon,
} from "./icons";

export function BrowserPanel(props: {
  browser: BrowserState;
  activeBrowserTabId: string | null;
  width: number;
  containerWidth: () => number;
  onResize: (width: number) => void;
  onResizeEnd: (width: number) => void;
  onActivateBrowserTab: (tabId: string) => void;
  onCloseBrowserTab: (tabId: string) => void;
  surfaceRef: (element: HTMLDivElement) => void;
}) {
  return (
    <aside
      id="browser-side-panel"
      class="browser-panel"
      classList={{ "browser-panel-controlled": Boolean(props.browser.activeBrowserControl()) }}
      aria-label="Browser"
    >
      <PanelResizer
        class="right-panel-resizer"
        label="Resize right panel"
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
      <header class="browser-panel-header">
        <div class="browser-tabs">
          <div class="browser-tab-strip" role="tablist" aria-label="Browser tabs">
            <For each={props.browser.browserTabs()}>
              {(tab) => {
                const control = () => props.browser.browserControlForTab(tab);
                const controller = () => props.browser.browserControllerForTab(tab);
                const title = () => (tab.loading ? "Loading…" : tab.title || tab.url);
                return (
                  <div
                    class="browser-tab-wrap"
                    classList={{ "browser-tab-controlled": Boolean(control()) }}
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-label={
                        control()
                          ? `${title()}, controlled by ${controller()?.name ?? "agent"}`
                          : title()
                      }
                      aria-selected={props.activeBrowserTabId === tab.id}
                      class="browser-tab"
                      classList={{
                        "browser-tab-active": props.browser.activeBrowserTab()?.id === tab.id,
                      }}
                      onClick={() => props.onActivateBrowserTab(tab.id)}
                    >
                      <Show when={control()}>
                        {(session) => (
                          <span
                            class="browser-tab-control"
                            classList={{
                              "browser-tab-control-acting": session().phase === "acting",
                            }}
                            title={`${controller()?.name ?? "Agent"}: ${BROWSER_ACTION_LABELS[session().action]}`}
                          >
                            <BrowserControlIcon />
                          </span>
                        )}
                      </Show>
                      <span class="browser-tab-title">{title()}</span>
                    </button>
                    <button
                      type="button"
                      class="browser-tab-close"
                      aria-label={`Close ${tab.title || "browser tab"}`}
                      onClick={() => props.onCloseBrowserTab(tab.id)}
                    >
                      <CloseIcon />
                    </button>
                  </div>
                );
              }}
            </For>
            <button
              type="button"
              class="browser-new-tab"
              aria-label="New browser tab"
              onClick={() => {
                props.browser.setBrowserAddress("https://www.google.com");
                void props.browser.openBrowserAddress();
              }}
            >
              <PlusIcon />
            </button>
          </div>
        </div>
      </header>
      <div class="browser-toolbar">
        <button type="button" aria-label="Go back" class="browser-toolbar-button" disabled>
          <BrowserBackIcon />
        </button>
        <button type="button" aria-label="Go forward" class="browser-toolbar-button" disabled>
          <BrowserForwardIcon />
        </button>
        <button
          type="button"
          aria-label="Reload page"
          class="browser-toolbar-button"
          onClick={() => void props.browser.openBrowserAddress()}
        >
          <BrowserReloadIcon />
        </button>
        <form
          class="browser-address-bar"
          onSubmit={(event) => {
            event.preventDefault();
            void props.browser.openBrowserAddress();
          }}
        >
          <input
            value={props.browser.browserAddress()}
            aria-label="Browser address"
            onInput={(event) => props.browser.setBrowserAddress(event.currentTarget.value)}
          />
        </form>
        <button type="button" class="browser-toolbar-button" aria-label="Browser menu">
          <span class="browser-menu-dots">•••</span>
        </button>
      </div>
      <div class="browser-surface" ref={props.surfaceRef}>
        <Show when={props.browser.browserTabs().length === 0}>
          <div class="browser-empty-state">
            <strong>Open a page</strong>
            <span>The agent can browse here while it works.</span>
          </div>
        </Show>
      </div>
    </aside>
  );
}

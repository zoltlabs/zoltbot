import { type JSX, onMount, Show } from "solid-js";
import { SidebarToggleIcon } from "../SidebarIcons";

export function CloudPanel(props: {
  title: string;
  sidebarCollapsed: boolean;
  onShowSidebar(): void;
  children: JSX.Element;
}) {
  let heading: HTMLHeadingElement | undefined;
  onMount(() => heading?.focus());
  return (
    <main aria-labelledby="cloud-page-title" class="map-panel">
      <header class="window-drag map-header">
        <Show when={props.sidebarCollapsed}>
          <button
            type="button"
            class="sidebar-icon-button sidebar-restore-button no-drag"
            aria-label="Show sidebar"
            aria-controls="bot-sidebar"
            aria-expanded="false"
            onClick={props.onShowSidebar}
          >
            <SidebarToggleIcon />
          </button>
        </Show>
        <h1 ref={heading} id="cloud-page-title" class="map-title" tabIndex={-1}>
          {props.title}
        </h1>
      </header>
      <div class="models-body">{props.children}</div>
    </main>
  );
}

import { Show } from "solid-js";
import { t } from "../i18n";

/** The Documents row under a project's heading in the sidebar. */
export function SidebarDocuments(props: {
  projectName: string;
  /** Document tasks whose changes wait for review. */
  ready: number;
  active: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      class="sidebar-channel-row sidebar-documents-row"
      classList={{ "sidebar-channel-row-active": props.active }}
      aria-current={props.active ? "page" : undefined}
      aria-label={t("documents.sidebar.label", { project: props.projectName })}
      onClick={props.onOpen}
    >
      <svg class="sidebar-documents-icon" viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M4 1.75h5.25L12.5 5v9.25H4z M9 1.75V5.25h3.5 M6 8h4.5 M6 10.5h4.5"
          fill="none"
          stroke="currentColor"
          stroke-width="1.2"
          stroke-linejoin="round"
        />
      </svg>
      <span class="sidebar-channel-name">{t("documents.sidebar.name")}</span>
      <Show when={props.ready > 0}>
        <span class="sidebar-tasks-count">
          {props.ready}
          <span class="sr-only"> {t("documents.sidebar.ready")}</span>
        </span>
      </Show>
    </button>
  );
}

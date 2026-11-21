// Back and forward arrows in the window's title area (C19).
import { t } from "../i18n";
import { Tooltip } from "../kit";

export function NavButtons(props: {
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
}) {
  return (
    <div class="nav-buttons no-drag">
      <Tooltip label={t("nav.back")}>
        <button
          type="button"
          class="sidebar-icon-button nav-button"
          aria-label={t("nav.back")}
          aria-keyshortcuts="Meta+["
          disabled={!props.canGoBack}
          onClick={() => props.onBack()}
        >
          <ArrowIcon path="M12 4.5 6.5 10l5.5 5.5" />
        </button>
      </Tooltip>
      <Tooltip label={t("nav.forward")}>
        <button
          type="button"
          class="sidebar-icon-button nav-button"
          aria-label={t("nav.forward")}
          aria-keyshortcuts="Meta+]"
          disabled={!props.canGoForward}
          onClick={() => props.onForward()}
        >
          <ArrowIcon path="m8 4.5 5.5 5.5L8 15.5" />
        </button>
      </Tooltip>
    </div>
  );
}

function ArrowIcon(props: { path: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="size-4 fill-none stroke-current">
      <path d={props.path} stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

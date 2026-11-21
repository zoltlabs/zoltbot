// D3: a small pill at the top of the window while an update downloads and once it's ready.
// "What's new" shows the release's notes.
import { createSignal, Show } from "solid-js";
import type { UpdateStatus } from "../../../shared/ipc";
import { t } from "../i18n";
import { Popover } from "../kit";
import "./update-pill.css";

export function UpdatePill(props: { status: UpdateStatus; onRestart: () => void }) {
  const [notesAnchor, setNotesAnchor] = createSignal<HTMLElement>();
  const phase = () => props.status.phase;
  const percent = () => Math.round(props.status.progress ?? 0);
  return (
    <Show when={phase() === "downloading" || phase() === "ready" || phase() === "installing"}>
      <div class="update-pill no-drag">
        <Show
          when={phase() !== "downloading"}
          fallback={
            <span class="update-pill-progress">
              {t("update.downloading", { percent: percent() })}
            </span>
          }
        >
          <button
            type="button"
            class="update-pill-restart"
            disabled={phase() === "installing"}
            onClick={() => props.onRestart()}
          >
            {t("update.restart")}
          </button>
        </Show>
        <Show when={props.status.releaseNotes}>
          <button
            type="button"
            class="update-pill-notes"
            aria-expanded={Boolean(notesAnchor())}
            onClick={(event) => setNotesAnchor(notesAnchor() ? undefined : event.currentTarget)}
          >
            {t("update.whatsNew")}
          </button>
        </Show>
      </div>
      <Show when={notesAnchor()}>
        {(anchor) => (
          <Popover
            anchor={anchor()}
            label={t("update.whatsNew")}
            width={360}
            placement="bottom"
            onClose={() => setNotesAnchor(undefined)}
          >
            <div class="update-notes" tabindex="0">
              {props.status.releaseNotes}
            </div>
          </Popover>
        )}
      </Show>
    </Show>
  );
}

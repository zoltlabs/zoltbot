// C17: every picture in the chat, one at a time. Arrow keys or a sideways swipe move between
// them; the zoom buttons or =, - and 0 change the size. Copy and Save… act on the one shown.
import { createSignal, type JSX } from "solid-js";
import type { AttachmentSummary } from "../../../../shared/ipc";
import { useShortcut } from "../../app-shortcuts";
import { t } from "../../i18n";
import { Dialog, Tooltip } from "../../kit";
import { BrowserBackIcon, BrowserForwardIcon, PlusIcon } from "./icons";
import "./gallery.css";

export type GalleryAction = "copy" | "save";
const ZOOMS = [0.25, 0.5, 1, 2, 4] as const;
/** The clipboard takes these as pictures; others, such as SVG, can still be saved. */
const COPYABLE = new Set(["image/png", "image/jpeg"]);

export const isGalleryImage = (attachment: AttachmentSummary) =>
  Boolean(attachment.previewUrl) &&
  (attachment.previewKind === "image" || attachment.previewKind === "svg");

export function Gallery(props: {
  images: AttachmentSummary[];
  start: number;
  onClose: () => void;
  onAction: (attachment: AttachmentSummary, action: GalleryAction) => void;
}) {
  const [index, setIndex] = createSignal(
    Math.min(Math.max(props.start, 0), Math.max(props.images.length - 1, 0)),
  );
  // "fit" shows the whole picture; a number is its size against its own pixels.
  const [zoom, setZoom] = createSignal<number | "fit">("fit");
  const current = () => props.images[index()] as AttachmentSummary;
  const count = () => props.images.length;

  const go = (step: number) => {
    const next = index() + step;
    if (next < 0 || next >= count()) return;
    setIndex(next);
    setZoom("fit");
  };
  const zoomBy = (direction: 1 | -1) => {
    const now = zoom() === "fit" ? 1 : (zoom() as number);
    const next =
      direction > 0
        ? ZOOMS.find((value) => value > now)
        : [...ZOOMS].reverse().find((v) => v < now);
    if (next !== undefined) setZoom(next);
  };

  const key = (id: string, keys: string, label: string, run: () => unknown) =>
    useShortcut({
      id: `gallery.${id}`,
      keys,
      when: "overlay",
      label,
      run: (event) => {
        if (run() === false) return false;
        event.preventDefault();
        return undefined;
      },
    });
  // While zoomed in, arrows scroll the picture instead.
  key("previous", "ArrowLeft", t("chat.gallery.previous"), () =>
    zoom() === "fit" ? void go(-1) : false,
  );
  key("next", "ArrowRight", t("chat.gallery.next"), () => (zoom() === "fit" ? void go(1) : false));
  key("zoomIn", "=", t("chat.gallery.zoomIn"), () => zoomBy(1));
  key("zoomOut", "-", t("chat.gallery.zoomOut"), () => zoomBy(-1));
  key("fit", "0", t("chat.gallery.fit"), () => setZoom("fit"));

  // A sideways two-finger swipe on a fitted picture moves to the next one.
  let swiped = 0;
  let resting = 0;
  const wheel = (event: WheelEvent) => {
    if (zoom() !== "fit" || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
    event.preventDefault();
    if (event.timeStamp < resting) return;
    swiped += event.deltaX;
    if (Math.abs(swiped) < 80) return;
    go(swiped > 0 ? 1 : -1);
    swiped = 0;
    resting = event.timeStamp + 450;
  };

  return (
    <Dialog
      title={current().name}
      width={1100}
      onClose={props.onClose}
      initialFocus=".gallery-stage"
      actions={
        <>
          {/* Stays in place for pictures the clipboard can't take, so the row never shifts. */}
          <button
            type="button"
            class="zb-kit-button"
            aria-disabled={!COPYABLE.has(current().mimeType) || undefined}
            onClick={() => {
              if (COPYABLE.has(current().mimeType)) props.onAction(current(), "copy");
            }}
          >
            {t("chat.gallery.copy")}
          </button>
          <button
            type="button"
            class="zb-kit-button"
            onClick={() => props.onAction(current(), "save")}
          >
            {t("chat.gallery.save")}
          </button>
          <button type="button" class="zb-kit-button primary" onClick={() => props.onClose()}>
            {t("chat.files.close")}
          </button>
        </>
      }
    >
      <div class="gallery-toolbar">
        <div class="gallery-nav">
          {/* aria-disabled, not disabled, so focus stays put at either end. */}
          <IconButton
            label={t("chat.gallery.previous")}
            hint={t("chat.gallery.previousHint")}
            off={index() === 0}
            onClick={() => go(-1)}
          >
            <BrowserBackIcon />
          </IconButton>
          <span class="gallery-count" aria-hidden="true">
            {t("chat.gallery.count", { index: index() + 1, total: count() })}
          </span>
          <IconButton
            label={t("chat.gallery.next")}
            hint={t("chat.gallery.nextHint")}
            off={index() === count() - 1}
            onClick={() => go(1)}
          >
            <BrowserForwardIcon />
          </IconButton>
          <span class="sr-only" aria-live="polite">
            {t("chat.gallery.announce", {
              name: current().name,
              index: index() + 1,
              total: count(),
            })}
          </span>
        </div>
        <fieldset class="gallery-zoom" aria-label={t("chat.gallery.zoom")}>
          <IconButton
            label={t("chat.gallery.zoomOut")}
            hint={t("chat.gallery.zoomOutHint")}
            off={zoom() === ZOOMS[0]}
            onClick={() => zoomBy(-1)}
          >
            <MinusIcon />
          </IconButton>
          <Tooltip
            label={zoom() === "fit" ? t("chat.gallery.actualSizeName") : t("chat.gallery.fitHint")}
          >
            <button
              type="button"
              class="zb-kit-button gallery-fit"
              aria-label={
                zoom() === "fit" ? t("chat.gallery.actualSizeName") : t("chat.gallery.fit")
              }
              onClick={() => setZoom(zoom() === "fit" ? 1 : "fit")}
            >
              {zoom() === "fit"
                ? t("chat.gallery.actualSize")
                : t("chat.gallery.percent", { value: (zoom() as number) * 100 })}
            </button>
          </Tooltip>
          <IconButton
            label={t("chat.gallery.zoomIn")}
            hint={t("chat.gallery.zoomInHint")}
            off={zoom() === ZOOMS.at(-1)}
            onClick={() => zoomBy(1)}
          >
            <PlusIcon />
          </IconButton>
        </fieldset>
      </div>
      <div
        class="gallery-stage"
        classList={{ zoomed: zoom() !== "fit" }}
        tabindex="0"
        role="region"
        aria-label={t("chat.gallery.stage")}
        onWheel={wheel}
      >
        <img
          src={current().previewUrl ?? ""}
          alt={current().name}
          style={
            zoom() === "fit"
              ? undefined
              : { zoom: String(zoom()), "max-width": "none", "max-height": "none" }
          }
        />
      </div>
    </Dialog>
  );
}

function IconButton(props: {
  label: string;
  hint: string;
  off: boolean;
  onClick: () => void;
  children: JSX.Element;
}) {
  return (
    <Tooltip label={props.hint}>
      <button
        type="button"
        class="zb-kit-button gallery-icon-button"
        aria-label={props.label}
        aria-disabled={props.off || undefined}
        onClick={() => {
          if (!props.off) props.onClick();
        }}
      >
        {props.children}
      </button>
    </Tooltip>
  );
}

function MinusIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="size-[14px] fill-none stroke-current">
      <path d="M4 10h12" stroke-width="1.3" stroke-linecap="round" />
    </svg>
  );
}

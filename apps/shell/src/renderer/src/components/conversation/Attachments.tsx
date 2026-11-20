import { createSignal, For, Show } from "solid-js";
import type { AttachmentSummary } from "../../../../shared/ipc";
import type { MediaPreview } from "./constants";
import { CloseIcon } from "./icons";

export function AttachmentCards(props: {
  attachments: AttachmentSummary[];
  onPreview: (attachment: AttachmentSummary) => void;
  onAction: (attachment: AttachmentSummary, action: "open" | "reveal") => void;
}) {
  return (
    <div class="message-attachments">
      <For each={props.attachments}>
        {(attachment) => (
          <div class="message-attachment">
            <button
              type="button"
              class="attachment-preview-button"
              disabled={attachment.previewKind === "none"}
              aria-label={`Preview ${attachment.name}`}
              onClick={() => props.onPreview(attachment)}
            >
              <Show
                when={attachment.previewKind === "image"}
                fallback={<span class="file-type-badge">{fileBadge(attachment)}</span>}
              >
                <img src={attachment.previewUrl ?? ""} alt="" />
              </Show>
              <span>
                <strong>{attachment.name}</strong>
                <small>{formatFileSize(attachment.size)}</small>
              </span>
            </button>
            <div class="attachment-actions">
              <button type="button" onClick={() => props.onAction(attachment, "open")}>
                Open
              </button>
              <button type="button" onClick={() => props.onAction(attachment, "reveal")}>
                Finder
              </button>
            </div>
          </div>
        )}
      </For>
    </div>
  );
}

export function fileBadge(attachment: AttachmentSummary): string {
  if (attachment.previewKind === "pdf") return "PDF";
  if (attachment.previewKind === "text") return "TXT";
  return attachment.name.split(".").at(-1)?.slice(0, 4).toUpperCase() || "FILE";
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function MediaPreviewDialog(props: {
  preview: MediaPreview;
  onClose: () => void;
  onAction: (attachment: AttachmentSummary, action: "open" | "reveal") => void;
}) {
  return (
    <div class="media-backdrop" role="presentation">
      <button
        type="button"
        class="media-dismiss"
        aria-label="Close media preview"
        onClick={() => props.onClose()}
      />
      <section
        class="media-modal"
        role="dialog"
        aria-modal="true"
        aria-label={props.preview.attachment.name}
      >
        <button
          type="button"
          class="media-close"
          aria-label="Close media preview"
          onClick={() => props.onClose()}
        >
          <CloseIcon />
        </button>
        <Show when={props.preview.attachment.previewKind === "image"}>
          <img
            class="media-image"
            src={props.preview.attachment.previewUrl ?? ""}
            alt={props.preview.attachment.name}
          />
        </Show>
        <Show when={props.preview.attachment.previewKind === "pdf"}>
          <iframe
            class="media-document"
            title={props.preview.attachment.name}
            src={props.preview.attachment.previewUrl ?? ""}
          />
        </Show>
        <Show when={props.preview.attachment.previewKind === "text"}>
          <pre class="media-text">
            {props.preview.loading ? "Loading…" : (props.preview.error ?? props.preview.text)}
          </pre>
        </Show>
        <div class="media-caption">
          <span>{props.preview.attachment.name}</span>
          <button type="button" onClick={() => props.onAction(props.preview.attachment, "open")}>
            Open
          </button>
          <button type="button" onClick={() => props.onAction(props.preview.attachment, "reveal")}>
            Show in Finder
          </button>
        </div>
      </section>
    </div>
  );
}

/** The attachment preview dialog's state, and opening an attachment in Finder or its app. */
export function createMediaPreview(onError: (message: string) => void) {
  const [mediaPreview, setMediaPreview] = createSignal<MediaPreview | null>(null);

  async function previewAttachment(attachment: AttachmentSummary) {
    if (!attachment.previewUrl || attachment.previewKind === "none") return;
    setMediaPreview({
      attachment,
      text: null,
      loading: attachment.previewKind === "text",
      error: null,
    });
    if (attachment.previewKind !== "text") return;
    try {
      const response = await fetch(attachment.previewUrl);
      if (!response.ok) throw new Error("Preview is unavailable.");
      const text = await response.text();
      setMediaPreview((current) =>
        current?.attachment.id === attachment.id
          ? { ...current, text: text.slice(0, 1_000_000), loading: false }
          : current,
      );
    } catch (error) {
      setMediaPreview((current) =>
        current?.attachment.id === attachment.id
          ? {
              ...current,
              loading: false,
              error: error instanceof Error ? error.message : String(error),
            }
          : current,
      );
    }
  }

  function attachmentAction(attachment: AttachmentSummary, action: "open" | "reveal") {
    void window.openbot.agent
      .openAttachment({ attachmentId: attachment.id, action })
      .catch((error) => onError(error instanceof Error ? error.message : String(error)));
  }

  return { mediaPreview, setMediaPreview, previewAttachment, attachmentAction };
}

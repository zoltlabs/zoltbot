import { createSignal, For, Show } from "solid-js";
import type { AttachmentSummary, OpenAttachmentInput } from "../../../../shared/ipc";
import { t } from "../../i18n";
import { Dialog, showToast } from "../../kit";
import type { MediaPreview } from "./constants";
import { FilePreview } from "./FilePreview";
import { formatFileSize } from "./file-read";
import { Gallery, isGalleryImage } from "./Gallery";

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
              aria-label={t("chat.files.preview", { name: attachment.name })}
              onClick={() => props.onPreview(attachment)}
            >
              <Show
                when={attachment.previewKind === "image" || attachment.previewKind === "svg"}
                fallback={<span class="file-type-badge">{fileBadge(attachment)}</span>}
              >
                <img src={attachment.previewUrl ?? ""} alt="" />
              </Show>
              <span>
                <strong>{attachment.name}</strong>
                <small>{formatFileSize(attachment.size)}</small>
              </span>
            </button>
            {/* A file with a preview opens it; its dialog holds Open and Show in Finder. */}
            <Show when={attachment.previewKind === "none" && attachment.actions.length > 0}>
              <div class="attachment-actions">
                <Show when={attachment.actions.includes("open")}>
                  <button type="button" onClick={() => props.onAction(attachment, "open")}>
                    {t("chat.files.open")}
                  </button>
                </Show>
                <Show when={attachment.actions.includes("reveal")}>
                  <button type="button" onClick={() => props.onAction(attachment, "reveal")}>
                    {t("chat.files.reveal")}
                  </button>
                </Show>
              </div>
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}

export function fileBadge(attachment: AttachmentSummary): string {
  if (attachment.previewKind === "pdf") return "PDF";
  if (attachment.previewKind === "markdown") return "MD";
  return attachment.name.split(".").at(-1)?.slice(0, 4).toUpperCase() || "FILE";
}

export { formatFileSize };

type AttachmentAction = OpenAttachmentInput["action"];

export function MediaPreviewDialog(props: {
  preview: MediaPreview;
  onClose: () => void;
  onAction: (attachment: AttachmentSummary, action: AttachmentAction) => void;
}) {
  const attachment = () => props.preview.attachment;
  return (
    <Show
      when={!props.preview.images}
      fallback={
        <Gallery
          images={props.preview.images ?? []}
          start={(props.preview.images ?? []).findIndex((image) => image.id === attachment().id)}
          onClose={props.onClose}
          onAction={props.onAction}
        />
      }
    >
      <FileDialog attachment={attachment()} onClose={props.onClose} onAction={props.onAction} />
    </Show>
  );
}

function FileDialog(props: {
  attachment: AttachmentSummary;
  onClose: () => void;
  onAction: (attachment: AttachmentSummary, action: AttachmentAction) => void;
}) {
  const attachment = () => props.attachment;
  return (
    <Dialog
      title={attachment().name}
      width={880}
      onClose={props.onClose}
      initialFocus=".file-preview-open"
      actions={
        <>
          <button type="button" class="zb-kit-button" onClick={() => props.onClose()}>
            {t("chat.files.close")}
          </button>
          <Show when={attachment().actions.includes("reveal")}>
            <button
              type="button"
              class="zb-kit-button"
              onClick={() => props.onAction(attachment(), "reveal")}
            >
              {t("chat.files.reveal")}
            </button>
          </Show>
          <Show when={attachment().actions.includes("open")}>
            <button
              type="button"
              class="zb-kit-button primary file-preview-open"
              onClick={() => props.onAction(attachment(), "open")}
            >
              {t("chat.files.open")}
            </button>
          </Show>
        </>
      }
    >
      <FilePreview attachment={attachment()} />
    </Dialog>
  );
}

/**
 * The attachment preview dialog's state, and acting on an attachment. A picture from the chat
 * opens the gallery of every picture in it (C17).
 */
export function createMediaPreview(
  onError: (message: string) => void,
  messages: () => readonly { attachments?: AttachmentSummary[] }[] = () => [],
) {
  const [mediaPreview, setMediaPreview] = createSignal<MediaPreview | null>(null);

  function previewAttachment(attachment: AttachmentSummary) {
    if (!attachment.previewUrl || attachment.previewKind === "none") return;
    const images = isGalleryImage(attachment)
      ? messages()
          .flatMap((message) => message.attachments ?? [])
          .filter(isGalleryImage)
      : [];
    const inChat = images.some((image) => image.id === attachment.id);
    setMediaPreview({ attachment, images: inChat ? images : null });
  }

  function attachmentAction(attachment: AttachmentSummary, action: AttachmentAction) {
    const failed = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      // The gallery covers the composer, so its errors show as a toast.
      if (action === "copy" || action === "save") showToast({ message });
      else onError(message);
    };
    void window.openbot.agent
      .openAttachment({ attachmentId: attachment.id, action })
      .then(() => {
        if (action === "copy") showToast({ message: t("chat.gallery.copied") });
      })
      .catch(failed);
  }

  return { mediaPreview, setMediaPreview, previewAttachment, attachmentAction };
}

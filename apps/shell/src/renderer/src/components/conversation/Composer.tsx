import { For, Show } from "solid-js";
import type { DraftAttachment, QueueSnapshot } from "../../../../shared/ipc";
import type { BotMessage, BotProfile } from "../../data";
import { ComposerEditor } from "../ComposerEditor";
import { type createDictation, DictationButton } from "../Dictation";
import { fileBadge, formatFileSize } from "./Attachments";
import { CloseIcon, FileIcon, PlusIcon, StopIcon } from "./icons";

export function Composer(props: {
  showAttachments: boolean;
  attachmentBusy: boolean;
  onToggleAttachments: () => void;
  onChooseAttachments: () => void;
  attachments: DraftAttachment[];
  onRemoveAttachment: (id: string) => void;
  replyTarget: BotMessage | undefined;
  onCancelReply: () => void;
  error: string | null;
  queue: QueueSnapshot | undefined;
  queueBarVisible: boolean;
  onResumeQueue: () => void;
  onCancelQueuedMessage: (deliveryId: string) => void;
  agentPickerOpen: boolean;
  agentReady: boolean;
  onboardingModelRequired: boolean;
  submitting: boolean;
  bot: BotProfile | undefined;
  bots: BotProfile[];
  text: string;
  onTextChange: (text: string) => void;
  onSubmit: () => void;
  dictation: ReturnType<typeof createDictation>;
  activeTurnId: string | null | undefined;
  onStop: () => void;
}) {
  return (
    <div class="composer-wrap">
      <Show when={props.showAttachments}>
        <div class="attachment-menu">
          <button type="button" disabled={props.attachmentBusy} onClick={props.onChooseAttachments}>
            <FileIcon />
            {props.attachmentBusy ? "Importing…" : "Attach files"}
          </button>
          <span class="attachment-menu-hint">You can also drop files or paste an image</span>
        </div>
      </Show>
      <For each={props.attachments}>
        {(attachment) => (
          <div class="composer-attachment">
            <span class={attachment.kind === "file" ? "file-type-badge" : "attachment-thumb"}>
              <Show when={attachment.kind === "image"} fallback={fileBadge(attachment)}>
                <img src={attachment.previewUrl ?? ""} alt="" />
              </Show>
            </span>
            <span>
              <strong>{attachment.name}</strong>
              <small>{formatFileSize(attachment.size)}</small>
            </span>
            <button
              type="button"
              aria-label={`Remove ${attachment.name}`}
              onClick={() => props.onRemoveAttachment(attachment.id)}
            >
              <CloseIcon />
            </button>
          </div>
        )}
      </For>
      <Show when={props.replyTarget}>
        {(message) => (
          <div class="composer-reply-preview">
            <div>
              <span>Replying to {message().author === "you" ? "your message" : "Agent"}</span>
              <p>{message().body || "Attachment"}</p>
            </div>
            <button type="button" aria-label="Cancel reply" onClick={props.onCancelReply}>
              <CloseIcon />
            </button>
          </div>
        )}
      </Show>
      <Show when={props.error}>
        <div class="composer-error" role="alert">
          {props.error}
        </div>
      </Show>
      <QueueBar
        queue={props.queue}
        visible={props.queueBarVisible}
        onResume={props.onResumeQueue}
        onCancel={props.onCancelQueuedMessage}
      />
      <div class="composer">
        <button
          type="button"
          class="composer-button"
          aria-label="Attach a file"
          disabled={
            props.agentPickerOpen ||
            props.attachmentBusy ||
            !props.agentReady ||
            props.onboardingModelRequired
          }
          onClick={props.onToggleAttachments}
        >
          <PlusIcon />
        </button>
        <div class="composer-input-label">
          <ComposerEditor
            botId={props.bot?.id}
            bots={props.bots}
            value={props.text}
            disabled={
              props.agentPickerOpen ||
              props.submitting ||
              !props.agentReady ||
              props.onboardingModelRequired
            }
            placeholder={
              !props.agentReady
                ? "Set up a coding agent to start"
                : props.onboardingModelRequired
                  ? "Choose a model to continue"
                  : props.replyTarget
                    ? "Reply…"
                    : `Message ${props.agentPickerOpen ? "agent" : (props.bot?.name ?? "agent")}`
            }
            ariaLabel={`Message ${props.agentPickerOpen ? "agent" : (props.bot?.name ?? "agent")}`}
            onValueChange={props.onTextChange}
            onSubmit={props.onSubmit}
          />
        </div>
        <Show when={props.dictation.available()}>
          <DictationButton
            dictation={props.dictation}
            disabled={
              props.agentPickerOpen ||
              props.submitting ||
              !props.agentReady ||
              props.onboardingModelRequired
            }
          />
        </Show>
        <Show
          when={props.activeTurnId}
          fallback={
            <button
              type="button"
              class="voice-button"
              aria-label="Send message"
              disabled={props.submitting || !props.agentReady || props.onboardingModelRequired}
              onClick={props.onSubmit}
            >
              {props.submitting ? "…" : "↑"}
            </button>
          }
        >
          <button
            type="button"
            class="voice-button voice-button-active"
            aria-label="Stop agent"
            onClick={props.onStop}
          >
            <StopIcon />
          </button>
        </Show>
      </div>
    </div>
  );
}

export function QueueBar(props: {
  queue: QueueSnapshot | undefined;
  visible: boolean;
  onResume: () => void;
  onCancel: (deliveryId: string) => void;
}) {
  return (
    <div
      class="agent-queue-bar"
      classList={{ "agent-queue-bar-visible": props.visible }}
      aria-hidden={!props.visible}
    >
      <Show when={props.queue?.paused}>
        <button type="button" onClick={props.onResume}>
          Resume queue
        </button>
      </Show>
      <For each={props.queue?.deliveries.filter((item) => item.status === "queued") ?? []}>
        {(delivery) => (
          <span>
            Queued #{delivery.position}
            <button
              type="button"
              aria-label={`Cancel queued message ${delivery.position}`}
              onClick={() => props.onCancel(delivery.id)}
            >
              <CloseIcon />
            </button>
          </span>
        )}
      </For>
    </div>
  );
}

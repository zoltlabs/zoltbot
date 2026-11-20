import { For, Show } from "solid-js";
import type { DraftAttachment, QueueSnapshot } from "../../../../shared/ipc";
import type { BotMessage, BotProfile } from "../../data";
import { t } from "../../i18n";
import { Menu } from "../../kit";
import { ComposerEditor } from "../ComposerEditor";
import { type createDictation, DictationButton } from "../Dictation";
import { fileBadge, formatFileSize } from "./Attachments";
import { createAsideMode } from "./aside-mode";
import { CloseIcon, FileIcon, PlusIcon, StopIcon } from "./icons";
import { QueueList } from "./QueueList";

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
  let attachButton: HTMLButtonElement | undefined;
  const aside = createAsideMode({
    botId: () => props.bot?.id,
    working: () => Boolean(props.activeTurnId),
    text: () => props.text,
    hasAttachments: () => props.attachments.length > 0,
    clear: () => props.onTextChange(""),
  });
  return (
    <div class="composer-wrap">
      <Show when={props.showAttachments && attachButton}>
        {(anchor) => (
          <Menu
            anchor={anchor()}
            label="Attach"
            groups={[
              [
                {
                  id: "files",
                  label: props.attachmentBusy ? "Importing…" : "Attach files",
                  icon: <FileIcon />,
                  disabled: props.attachmentBusy,
                  run: props.onChooseAttachments,
                },
              ],
            ]}
            onClose={props.onToggleAttachments}
          />
        )}
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
      <Show when={props.error ?? aside.error()}>
        <div class="composer-error" role="alert">
          {props.error ?? aside.error()}
        </div>
      </Show>
      <QueueList
        botId={props.bot?.id}
        queue={props.queue}
        visible={props.queueBarVisible}
        onResume={props.onResumeQueue}
        onCancel={props.onCancelQueuedMessage}
        onEdit={(text) => props.onTextChange(props.text.trim() ? `${text}\n\n${props.text}` : text)}
      />
      <div class="composer">
        <button
          ref={attachButton}
          type="button"
          class="composer-button"
          aria-label="Attach a file"
          aria-haspopup="menu"
          aria-expanded={props.showAttachments}
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
              aside.active()
                ? t("aside.placeholder")
                : !props.agentReady
                  ? "Set up a coding agent to start"
                  : props.onboardingModelRequired
                    ? "Choose a model to continue"
                    : props.replyTarget
                      ? "Reply…"
                      : `Message ${props.agentPickerOpen ? "agent" : (props.bot?.name ?? "agent")}`
            }
            ariaLabel={`Message ${props.agentPickerOpen ? "agent" : (props.bot?.name ?? "agent")}`}
            onValueChange={props.onTextChange}
            onSubmit={(options) => (aside.wanted(options) ? void aside.ask() : props.onSubmit())}
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
            class="composer-aside-toggle"
            aria-pressed={aside.active()}
            title={t("aside.askHint")}
            aria-keyshortcuts="Alt+Enter"
            onClick={aside.toggle}
          >
            {t("aside.ask")}
          </button>
          <span class="sr-only" aria-live="polite">
            {aside.announcement()}
          </span>
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

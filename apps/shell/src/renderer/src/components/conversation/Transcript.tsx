import { splitQuote } from "@zoltbot/protocol";
import { createMemo, createSignal, For, Show } from "solid-js";
import type {
  AgentModelId,
  AgentModelOption,
  AgentStatus,
  ArtifactSummary,
  AttachmentSummary,
} from "../../../../shared/ipc";
import type { BotMessage, BotProfile } from "../../data";
import { t } from "../../i18n";
import { Menu } from "../../kit";
import { AgentAvatar } from "../AgentAvatar";
import { ArtifactCards } from "../ArtifactPanel";
import { ChoiceCard } from "../ConversationPrompts";
import { ProviderModelPicker } from "../ProviderModelPicker";
import { AsideEntry } from "./Aside";
import { AttachmentCards } from "./Attachments";
import { BranchList } from "./Branching";
import { ONBOARDING_CHOICES } from "./constants";
import { HiddenMessage } from "./HiddenMessage";
import { LinkIcon } from "./icons";
import { MessageActions, type MessageActionsState } from "./MessageActions";
import { ProgressNote } from "./ProgressNote";
import { ThinkingDisclosure } from "./WorkingLine";

export function ExchangeAgentAvatar(props: { bot: BotProfile | undefined }) {
  return <AgentAvatar bot={props.bot} class="exchange-agent-avatar" />;
}

export function ExchangeSystemRow(props: {
  message: BotMessage;
  bots: BotProfile[];
  onSelectAgent: (botId: string) => void;
}) {
  const [agentsOpen, setAgentsOpen] = createSignal(false);
  let agentsTrigger: HTMLButtonElement | undefined;
  const exchange = () => props.message.exchange;
  const recipients = () => exchange()?.recipientBotIds ?? [];
  const sender = () => {
    const senderId = exchange()?.senderBotId;
    return props.bots.find((bot) => bot.id === senderId);
  };
  const singleRecipient = () => {
    const recipientId = recipients()[0];
    return recipientId ? props.bots.find((bot) => bot.id === recipientId) : undefined;
  };
  const agentCountLabel = () => `${recipients().length} agents`;

  return (
    <div class="exchange-system-row">
      <Show
        when={exchange()?.direction === "outgoing"}
        fallback={
          <>
            <span class="exchange-system-label">Message from</span>
            <button
              type="button"
              class="exchange-agent-trigger exchange-agent-trigger-incoming"
              aria-label={`Open exchange with ${sender()?.name ?? exchange()?.senderBotId ?? "agent"}`}
              onClick={() => {
                const senderId = exchange()?.senderBotId;
                if (senderId) props.onSelectAgent(senderId);
              }}
            >
              <ExchangeAgentAvatar bot={sender()} />
              <span>{sender()?.name ?? exchange()?.senderBotId ?? "Agent"}</span>
            </button>
          </>
        }
      >
        <span class="exchange-system-label">Messaged</span>
        <Show
          when={recipients().length === 1}
          fallback={
            <div class="exchange-agent-picker">
              <button
                ref={agentsTrigger}
                type="button"
                class="exchange-agent-trigger exchange-agent-trigger-outgoing"
                aria-haspopup="menu"
                aria-expanded={agentsOpen()}
                aria-label={`${agentCountLabel()}, show list`}
                onClick={() => setAgentsOpen((open) => !open)}
              >
                <span class="exchange-avatar-stack" aria-hidden="true">
                  <For each={recipients().slice(0, 3)}>
                    {(recipientId) => (
                      <ExchangeAgentAvatar bot={props.bots.find((bot) => bot.id === recipientId)} />
                    )}
                  </For>
                </span>
                <span>{agentCountLabel()}</span>
              </button>
              <Show when={agentsOpen() && agentsTrigger}>
                {(anchor) => (
                  <Menu
                    anchor={anchor()}
                    label={agentCountLabel()}
                    groups={[
                      recipients().map((recipientId) => {
                        const recipient = props.bots.find((bot) => bot.id === recipientId);
                        return {
                          id: recipientId,
                          label: recipient?.name ?? recipientId,
                          icon: <ExchangeAgentAvatar bot={recipient} />,
                          run: () => props.onSelectAgent(recipientId),
                        };
                      }),
                    ]}
                    onClose={() => setAgentsOpen(false)}
                  />
                )}
              </Show>
            </div>
          }
        >
          <button
            type="button"
            class="exchange-agent-trigger exchange-agent-trigger-single"
            aria-label={`Open exchange with ${singleRecipient()?.name ?? recipients()[0] ?? "agent"}`}
            title={singleRecipient()?.name ?? recipients()[0] ?? "Agent"}
            onClick={() => {
              const recipientId = recipients()[0];
              if (recipientId) props.onSelectAgent(recipientId);
            }}
          >
            <ExchangeAgentAvatar bot={singleRecipient()} />
            <span>{singleRecipient()?.name ?? recipients()[0] ?? "Agent"}</span>
          </button>
        </Show>
      </Show>
      <time dateTime={props.message.time}>{props.message.time}</time>
    </div>
  );
}

export function MessageBody(props: {
  message: BotMessage;
  referencedMessage?: BotMessage;
  bots: BotProfile[];
  onSelectAgent: (botId: string) => void;
  onOpenLink: (url: string) => void;
  onPreview: (attachment: AttachmentSummary) => void;
  onAttachmentAction: (attachment: AttachmentSummary, action: "open" | "reveal") => void;
  openArtifactVersionId: string | null;
  onOpenArtifact: (artifact: ArtifactSummary) => void;
}) {
  // A sent reply carries its quote in the text; show it as the reply context.
  const sent = () =>
    props.message.author === "you" && !props.referencedMessage
      ? splitQuote(props.message.body)
      : undefined;
  const words = () => sent()?.rest ?? props.message.body;
  return (
    <>
      <Show when={props.referencedMessage}>
        {(referenced) => (
          <div class="message-reply-context">
            <span>{referenced().author === "you" ? "You" : "Agent"}</span>
            <p>{referenced().hidden ? t("chat.hide.row") : referenced().body || "Attachment"}</p>
          </div>
        )}
      </Show>
      <Show when={sent()}>
        {(reply) => (
          <div class="message-reply-context message-reply-context-sent">
            <span class="sr-only">{t("chat.reply.quoted")}</span>
            <p>{reply().quote}</p>
          </div>
        )}
      </Show>
      <Show when={words()}>
        <p class="message-copy">
          <RichMessageText
            body={words()}
            bots={props.bots}
            onSelectAgent={props.onSelectAgent}
            onOpenLink={props.onOpenLink}
          />
        </p>
      </Show>
      <Show when={props.message.status}>
        <div class="message-status">
          <span />
          {props.message.status}
        </div>
      </Show>
      <Show when={props.message.attachments?.length}>
        <AttachmentCards
          attachments={props.message.attachments ?? []}
          onPreview={props.onPreview}
          onAction={props.onAttachmentAction}
        />
      </Show>
      <Show when={props.message.artifacts?.length}>
        <ArtifactCards
          artifacts={props.message.artifacts ?? []}
          openVersionId={props.openArtifactVersionId}
          onOpen={props.onOpenArtifact}
        />
      </Show>
    </>
  );
}

export function RichMessageText(props: {
  body: string;
  bots: BotProfile[];
  onSelectAgent: (botId: string) => void;
  onOpenLink: (url: string) => void;
}) {
  const parts = createMemo(() => richMessageParts(props.body, props.bots));
  return (
    <For each={parts()}>
      {(part) => {
        if (part.url) {
          return (
            <a
              class="message-link"
              href={part.url}
              title={part.url}
              onClick={(event) => {
                event.preventDefault();
                props.onOpenLink(part.url ?? "");
              }}
            >
              <span class="message-link-icon" aria-hidden="true">
                <LinkIcon />
                <img
                  src={faviconUrl(part.url)}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  referrerPolicy="no-referrer"
                  onError={(event) => event.currentTarget.remove()}
                />
              </span>
              {part.text}
            </a>
          );
        }
        if (part.bot) {
          return (
            <button
              type="button"
              class="message-agent-tag"
              aria-label={`Open agent ${part.bot.name}`}
              onClick={() => props.onSelectAgent(part.bot?.id ?? "")}
            >
              <AgentAvatar bot={part.bot} />
              <span>{part.bot.name}</span>
            </button>
          );
        }
        return part.text;
      }}
    </For>
  );
}

export interface RichMessagePart {
  text: string;
  bot?: BotProfile;
  url?: string;
}

export function richMessageParts(body: string, bots: BotProfile[]): RichMessagePart[] {
  const parts: RichMessagePart[] = [];
  for (const part of linkedMessageParts(body)) {
    if (part.url) parts.push(part);
    else parts.push(...taggedMessageParts(part.text, bots));
  }
  return parts;
}

export function linkedMessageParts(body: string): RichMessagePart[] {
  const expression = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]+)/giu;
  const parts: RichMessagePart[] = [];
  let cursor = 0;
  for (const match of body.matchAll(expression)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push({ text: body.slice(cursor, index) });
    const markdownUrl = match[2];
    const rawUrl = match[3];
    const rawLink = markdownUrl ?? rawUrl ?? "";
    const cleanLink = rawLink.replace(/[.,!?;:]+$/u, "");
    const url = safeBrowserUrl(cleanLink);
    if (!url) {
      parts.push({ text: match[0] });
    } else {
      parts.push({ text: match[1] ?? cleanLink, url });
      const trailingText = rawLink.slice(cleanLink.length);
      if (trailingText) parts.push({ text: trailingText });
    }
    cursor = index + match[0].length;
  }
  if (cursor < body.length) parts.push({ text: body.slice(cursor) });
  return parts.length > 0 ? parts : [{ text: body }];
}

export function safeBrowserUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function faviconUrl(value: string): string {
  return `${new URL(value).origin}/favicon.ico`;
}

export function taggedMessageParts(body: string, bots: BotProfile[]) {
  const orderedBots = [...bots].sort((left, right) => right.name.length - left.name.length);
  if (orderedBots.length === 0) return [{ text: body, bot: undefined }];
  const botsByName = new Map(orderedBots.map((bot) => [bot.name.toLocaleLowerCase(), bot]));
  const expression = new RegExp(
    `@(${orderedBots.map((bot) => escapeExpression(bot.name)).join("|")})(?=$|[\\s.,!?;:()\\[\\]{}])`,
    "giu",
  );
  const parts: Array<{ text: string; bot: BotProfile | undefined }> = [];
  let cursor = 0;
  for (const match of body.matchAll(expression)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push({ text: body.slice(cursor, index), bot: undefined });
    const name = match[1] ?? "";
    const bot = botsByName.get(name.toLocaleLowerCase());
    parts.push({ text: match[0], bot });
    cursor = index + match[0].length;
  }
  if (cursor < body.length) parts.push({ text: body.slice(cursor), bot: undefined });
  return parts.length > 0 ? parts : [{ text: body, bot: undefined }];
}

export function escapeExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function TranscriptEntry(props: {
  message: BotMessage;
  messages: BotMessage[];
  bots: BotProfile[];
  /** C8: the chat's agent, shown on its reactions. */
  agent?: BotProfile;
  /** Chats branched from this one, by the message each shows under. */
  branches?: ReadonlyMap<string, BotProfile[]>;
  animate: boolean;
  actions: MessageActionsState;
  onSelectAgent: (botId: string) => void;
  onOpenLink: (url: string) => void;
  onPreview: (attachment: AttachmentSummary) => void;
  onAttachmentAction: (attachment: AttachmentSummary, action: "open" | "reveal") => void;
  openArtifactVersionId: string | null;
  onOpenArtifact: (artifact: ArtifactSummary) => void;
}) {
  const branchesHere = () => props.branches?.get(props.message.id) ?? [];
  // A message stays an aside or not for its whole life, so this choice needn't be reactive.
  if (props.message.aside)
    return <AsideEntry message={props.message} onOpenChat={props.onSelectAgent} />;
  if (props.message.progress) return <ProgressNote message={props.message} agent={props.agent} />;
  return (
    <Show
      when={!props.message.hidden}
      fallback={
        <>
          <HiddenMessage
            messageId={props.message.id}
            onShow={() => props.actions.show(props.message)}
          />
          <Show when={branchesHere().length > 0}>
            <BranchList branches={branchesHere()} onOpenChat={props.onSelectAgent} />
          </Show>
        </>
      }
    >
      <Show
        when={props.message.exchange}
        fallback={
          <Show
            when={props.message.kind === "thinking"}
            fallback={
              <article
                class="message-entry"
                data-message-id={props.message.id}
                onContextMenu={(event) => {
                  if (props.message.streaming) return;
                  event.preventDefault();
                  const more =
                    event.currentTarget.querySelector<HTMLElement>(".message-more-button");
                  // Shift+F10 and the menu key give no pointer position; open by More instead.
                  const fromKeyboard = event.clientX === 0 && event.clientY === 0;
                  const selected = window.getSelection();
                  const selection =
                    selected &&
                    !selected.isCollapsed &&
                    event.currentTarget.contains(selected.anchorNode)
                      ? selected.toString().trim()
                      : "";
                  props.actions.openMenuAt(
                    props.message.id,
                    fromKeyboard && more ? more : { x: event.clientX, y: event.clientY },
                    more ?? undefined,
                    selection || undefined,
                  );
                }}
                classList={{
                  "message-entry-animated": props.animate,
                  "message-entry-user": props.message.author === "you",
                  "message-entry-bot": props.message.author === "bot",
                }}
              >
                <div class="message-shell">
                  <div
                    class={props.message.author === "you" ? "user-bubble" : "bot-bubble"}
                    classList={{ "bot-bubble-streaming": props.message.streaming === true }}
                  >
                    <MessageBody
                      message={props.message}
                      referencedMessage={props.messages.find(
                        (candidate) => candidate.id === props.message.replyToMessageId,
                      )}
                      bots={props.bots}
                      onSelectAgent={props.onSelectAgent}
                      onOpenLink={props.onOpenLink}
                      onPreview={props.onPreview}
                      onAttachmentAction={props.onAttachmentAction}
                      openArtifactVersionId={props.openArtifactVersionId}
                      onOpenArtifact={props.onOpenArtifact}
                    />
                  </div>
                  <MessageActions message={props.message} actions={props.actions} />
                </div>
                <Show when={props.message.reaction}>
                  {(reaction) => (
                    <button
                      type="button"
                      class="message-reaction-pill"
                      aria-label={t("chat.message.removeReaction", { emoji: reaction() })}
                      onClick={() => props.actions.react(props.message, null)}
                    >
                      {reaction()}
                    </button>
                  )}
                </Show>
                <Show when={props.message.agentReaction}>
                  {(emoji) => (
                    <span
                      class="message-reaction-pill message-reaction-agent"
                      role="img"
                      title={t("chat.reaction.agent", { name: props.agent?.name ?? "Agent" })}
                      aria-label={t("chat.reaction.agentLabel", {
                        name: props.agent?.name ?? "Agent",
                        emoji: emoji(),
                      })}
                    >
                      <AgentAvatar bot={props.agent} class="message-reaction-avatar" />
                      {emoji()}
                    </span>
                  )}
                </Show>
                <BranchList branches={branchesHere()} onOpenChat={props.onSelectAgent} />
              </article>
            }
          >
            <div classList={{ "thinking-entry-animated": props.animate }}>
              <ThinkingDisclosure message={props.message} />
            </div>
          </Show>
        }
      >
        {(exchange) => (
          <article
            class="exchange-message-entry"
            classList={{ "exchange-message-entry-animated": props.animate }}
          >
            <ExchangeSystemRow
              message={props.message}
              bots={props.bots}
              onSelectAgent={props.onSelectAgent}
            />
            <Show
              when={
                exchange().direction === "incoming" && (props.message.attachments?.length ?? 0) > 0
              }
            >
              <div class="exchange-agent-attachments">
                <AttachmentCards
                  attachments={props.message.attachments ?? []}
                  onPreview={props.onPreview}
                  onAction={props.onAttachmentAction}
                />
              </div>
            </Show>
          </article>
        )}
      </Show>
    </Show>
  );
}

export function AgentSetupCard(props: { agentStatus: AgentStatus; onSetup: () => void }) {
  return (
    <section class="agent-setup-card" role="status">
      <div>
        <strong>
          {props.agentStatus.phase === "starting" || props.agentStatus.phase === "restarting"
            ? "Connecting to Zoltbot…"
            : "Set up a coding agent"}
        </strong>
        <p>
          {props.agentStatus.message ?? "Install or sign in to a coding agent to start chatting."}
        </p>
      </div>
      <Show
        when={props.agentStatus.phase !== "starting" && props.agentStatus.phase !== "restarting"}
      >
        <button type="button" onClick={props.onSetup}>
          Set up
        </button>
      </Show>
    </section>
  );
}

export function OnboardingStep(props: {
  modelValue: AgentModelId;
  agentStatus: AgentStatus;
  modelOptions: AgentModelOption[];
  onModelChange: (model: AgentModelId) => void;
  modelConfirmed: boolean;
  submitting: boolean;
  onSubmit: (answer: string) => Promise<boolean>;
}) {
  return (
    <article class="message-entry message-entry-animated message-entry-bot onboarding-message">
      <div class="bot-bubble">
        <p class="message-copy">Choose a model to get started.</p>
      </div>
      <div class="onboarding-model-picker">
        <ProviderModelPicker
          ariaLabel="Onboarding model"
          value={props.modelValue}
          agentStatus={props.agentStatus}
          modelOptions={props.modelOptions}
          onChange={props.onModelChange}
        />
      </div>
      <Show when={props.modelConfirmed}>
        <div class="onboarding-specialty-step message-entry-animated">
          <ChoiceCard
            title="What do you want me helping with most?"
            hint="This becomes my ongoing specialty. You can change it later in Settings."
            choices={ONBOARDING_CHOICES}
            customChoice="Something else"
            pending={props.submitting}
            onSubmit={props.onSubmit}
          />
        </div>
      </Show>
    </article>
  );
}

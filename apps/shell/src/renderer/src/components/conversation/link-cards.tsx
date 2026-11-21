// C15: cards for up to two links in a message: the page's picture, site and title.
import { LINK_PREVIEWS_PER_MESSAGE, linksIn } from "@zoltbot/protocol";
import { createResource, createRoot, createSignal, For, Show } from "solid-js";
import type { LinkCard } from "../../../../shared/links";
import "./link-cards.css";

const [enabled, setEnabledSignal] = createRoot(() => createSignal(true));
let loaded = false;
let chosen = false;

/** Whether cards show. Reading it loads the saved setting once. */
export function linkPreviewsEnabled(): boolean {
  if (!loaded) {
    loaded = true;
    void window.openbot?.links
      ?.enabled()
      .then((value) => {
        if (!chosen) setEnabledSignal(value);
      })
      .catch(() => undefined);
  }
  return enabled();
}

export function setLinkPreviewsEnabled(next: boolean): Promise<void> {
  chosen = true;
  const before = enabled();
  setEnabledSignal(next);
  return (window.openbot?.links?.setEnabled(next) ?? Promise.resolve()).catch((error: unknown) => {
    setEnabledSignal(before);
    throw error;
  });
}

// Cards already read in this window, by message and link, so scrolling back doesn't ask again.
const cards = new Map<string, Promise<LinkCard | null>>();

function readCard(botId: string, messageId: string, url: string) {
  const key = `${botId} ${messageId} ${url}`;
  let card = cards.get(key);
  if (!card) {
    card = window.openbot.links.preview({ botId, messageId, url }).catch(() => null);
    if (cards.size >= 300) cards.delete(cards.keys().next().value as string);
    cards.set(key, card);
  }
  return card;
}

/** The links a message gets cards for: web links only, at most two. */
export function cardLinks(body: string): string[] {
  return linksIn(body).slice(0, LINK_PREVIEWS_PER_MESSAGE);
}

export function LinkCards(props: {
  botId: string;
  messageId: string;
  body: string;
  onOpenLink: (url: string) => void;
}) {
  return (
    <Show when={linkPreviewsEnabled() && cardLinks(props.body).length > 0}>
      <div class="link-cards">
        <For each={cardLinks(props.body)}>
          {(url) => (
            <LinkCardView
              botId={props.botId}
              messageId={props.messageId}
              url={url}
              onOpenLink={props.onOpenLink}
            />
          )}
        </For>
      </div>
    </Show>
  );
}

function LinkCardView(props: {
  botId: string;
  messageId: string;
  url: string;
  onOpenLink: (url: string) => void;
}) {
  const [card] = createResource(
    () => [props.botId, props.messageId, props.url] as const,
    ([botId, messageId, url]) => readCard(botId, messageId, url),
  );
  return (
    <Show when={card()}>
      {(found) => (
        <a
          class="link-card"
          href={found().url}
          title={found().url}
          onClick={(event) => {
            event.preventDefault();
            props.onOpenLink(found().url);
          }}
        >
          <Show when={found().image}>
            {(image) => <img src={image()} alt="" decoding="async" />}
          </Show>
          <span class="link-card-copy">
            <span class="link-card-site">{found().siteName}</span>
            <strong>{found().title}</strong>
            <Show when={found().description}>
              <span class="link-card-description">{found().description}</span>
            </Show>
          </span>
        </a>
      )}
    </Show>
  );
}

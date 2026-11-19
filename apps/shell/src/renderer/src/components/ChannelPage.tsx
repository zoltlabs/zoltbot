import { createEffect, createMemo, createSignal, For, on, onMount, Show } from "solid-js";
import type { ChannelDetail, ChannelPostView, ChannelRequestView } from "../../../shared/channels";
import { currentRequest, openTasks, REQUEST_STATE_LABELS, shortTime, taskLine } from "../channels";
import type { ChannelsStore } from "../channels-store";
import { ChannelComposer } from "./ChannelComposer";
import { ChannelPanel } from "./ChannelPanel";
import { SidebarToggleIcon } from "./SidebarIcons";

interface ChannelPageProps {
  store: ChannelsStore;
  sidebarCollapsed: boolean;
  onShowSidebar: () => void;
  onOpenChat: (threadId: string) => void;
}

/** A team channel in place of the conversation: posts, the current request and who owes a reply. */
export function ChannelPage(props: ChannelPageProps) {
  let heading: HTMLHeadingElement | undefined;
  let transcript: HTMLOListElement | undefined;
  const detail = () => props.store.detail();
  const name = createMemo(
    () =>
      detail()?.channel.name ??
      props.store.channels().find((channel) => channel.id === props.store.openId())?.name ??
      "",
  );
  onMount(() => heading?.focus());
  createEffect(
    on(
      () => props.store.openId(),
      () => heading?.focus(),
      { defer: true },
    ),
  );
  // Keep the newest post in view as posts arrive. Earlier posts loaded above don't move it.
  createEffect(
    on(
      () => detail()?.posts.at(-1)?.id,
      () =>
        requestAnimationFrame(() => {
          if (transcript) transcript.scrollTop = transcript.scrollHeight;
        }),
    ),
  );

  /** Loads older posts above, keeping the posts in view where they were. */
  async function showEarlier() {
    const list = transcript;
    const fromBottom = list ? list.scrollHeight - list.scrollTop : 0;
    const loaded = await props.store.loadEarlier();
    if (!loaded || !list) return;
    requestAnimationFrame(() => {
      list.scrollTop = list.scrollHeight - fromBottom;
      // The button is gone once the first post shows; keep focus in the transcript.
      if (!detail()?.more) list.focus();
    });
  }

  return (
    <main aria-label={`#${name()}`} class="map-panel channel-page">
      <header class="window-drag map-header channel-header">
        <Show when={props.sidebarCollapsed}>
          <button
            type="button"
            class="sidebar-icon-button sidebar-restore-button no-drag"
            aria-label="Show sidebar"
            aria-controls="bot-sidebar"
            aria-expanded="false"
            title="Show sidebar"
            onClick={props.onShowSidebar}
          >
            <SidebarToggleIcon />
          </button>
        </Show>
        <h1 ref={heading} class="map-title channel-title" tabIndex={-1}>
          #{name()}
        </h1>
        <Show when={detail()}>
          {(current) => (
            <span class="channel-member-count">
              {current().members.length + 1} {current().members.length ? "members" : "member"}
            </span>
          )}
        </Show>
      </header>
      <Show when={detail()} fallback={<div class="channel-body" />}>
        {(current) => (
          <div class="channel-body">
            <div class="channel-main">
              <RequestBar detail={current()} store={props.store} />
              <ol ref={transcript} class="channel-transcript" aria-label="Posts" tabIndex={-1}>
                <Show when={current().more}>
                  <li class="channel-earlier">
                    <button
                      type="button"
                      class="channel-text-button channel-earlier-button"
                      disabled={props.store.loadingEarlier()}
                      onClick={() => void showEarlier()}
                    >
                      {props.store.loadingEarlier() ? "Loading…" : "Show earlier"}
                    </button>
                  </li>
                </Show>
                <Show when={current().posts.length === 0}>
                  <li class="channel-empty">No posts yet.</li>
                </Show>
                <For each={current().posts}>
                  {(post) => <Post post={post} detail={current()} onOpenChat={props.onOpenChat} />}
                </For>
              </ol>
              <Waiting detail={current()} />
              <Show when={props.store.error()}>
                <p class="channel-error" role="alert">
                  {props.store.error()}
                </p>
              </Show>
              <ChannelComposer
                channelName={current().channel.name}
                members={current().members}
                onSend={props.store.post}
              />
            </div>
            <ChannelPanel
              detail={current()}
              onOpenChat={props.onOpenChat}
              onAct={(request, action) => void props.store.act(request, action)}
            />
          </div>
        )}
      </Show>
    </main>
  );
}

function Post(props: {
  post: ChannelPostView;
  detail: ChannelDetail;
  onOpenChat: (threadId: string) => void;
}) {
  const owner = () => props.post.author.kind === "owner";
  const author = () => props.post.author;
  const lead = () => {
    const speaker = author();
    return speaker.kind === "member" && speaker.threadId === props.detail.channel.leadThreadId;
  };
  /** Tasks the lead assigned for the request this post started. */
  const tasks = createMemo(() => {
    if (!owner() || !props.post.requestId) return [];
    const first = props.detail.posts.find(
      (post) => post.requestId === props.post.requestId && post.author.kind === "owner",
    );
    if (first?.id !== props.post.id) return [];
    return (
      props.detail.requests.find((request) => request.id === props.post.requestId)?.tasks ?? []
    );
  });
  return (
    <>
      <li class="channel-post" classList={{ "channel-post-owner": owner() }}>
        <div class="channel-post-head">
          <Show
            when={author().kind === "member" ? author() : null}
            fallback={<span class="channel-speaker">You</span>}
          >
            {(speaker) => (
              <button
                type="button"
                class="channel-speaker channel-link"
                onClick={() => props.onOpenChat((speaker() as { threadId: string }).threadId)}
              >
                {(speaker() as { name: string }).name}
              </button>
            )}
          </Show>
          <Show when={lead()}>
            <span class="channel-lead-badge">Lead</span>
          </Show>
          <Show when={props.post.to.length > 0}>
            <span class="channel-post-to">to {props.post.to.join(", ")}</span>
          </Show>
          <time class="channel-post-time" dateTime={props.post.createdAt}>
            {shortTime(props.post.createdAt)}
          </time>
        </div>
        <p class="channel-bubble">{props.post.text}</p>
      </li>
      <For each={tasks()}>
        {(task) => (
          <li class="channel-task-line">
            <span class={`task-dot task-dot-${taskLine(task.state).tone}`} aria-hidden="true" />
            <span>
              {task.title} · {taskLine(task.state).label}
            </span>
          </li>
        )}
      </For>
    </>
  );
}

function RequestBar(props: { detail: ChannelDetail; store: ChannelsStore }) {
  const request = createMemo(() => currentRequest(props.detail.requests));
  const [confirming, setConfirming] = createSignal(false);
  const [reassigning, setReassigning] = createSignal(false);
  createEffect(
    on(
      () => request()?.id,
      () => {
        setConfirming(false);
        setReassigning(false);
      },
    ),
  );
  function stop(current: ChannelRequestView) {
    if (openTasks(current).length && !confirming()) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    void props.store.act(current, "stop");
  }
  return (
    <Show when={request()}>
      {(current) => (
        <section class="channel-request-bar" aria-label="Current request">
          <div class="channel-request-bar-copy">
            <span class="channel-request-bar-title">{current().title}</span>
            <span class="channel-request-meta">
              <span class={`task-dot channel-dot-${current().state}`} aria-hidden="true" />
              {REQUEST_STATE_LABELS[current().state]} · {current().leadName}
              <Show when={current().tasks.length > 0}>
                {` · ${current().tasks.length} ${current().tasks.length === 1 ? "task" : "tasks"}`}
              </Show>
            </span>
          </div>
          <Show
            when={!confirming()}
            fallback={
              <div class="channel-request-bar-actions" role="group" aria-label="Stop request">
                <span class="channel-confirm-copy">
                  Stops {openTasks(current()).length}{" "}
                  {openTasks(current()).length === 1 ? "task" : "tasks"}.
                </span>
                <button
                  type="button"
                  class="channel-button channel-button-danger"
                  ref={(button) => requestAnimationFrame(() => button.focus())}
                  onClick={() => stop(current())}
                >
                  Stop request
                </button>
                <button type="button" class="channel-button" onClick={() => setConfirming(false)}>
                  Cancel
                </button>
              </div>
            }
          >
            <div class="channel-request-bar-actions">
              <Show
                when={reassigning()}
                fallback={
                  <button
                    type="button"
                    class="channel-button"
                    disabled={props.detail.members.length < 2}
                    onClick={() => setReassigning(true)}
                  >
                    Reassign
                  </button>
                }
              >
                <select
                  class="channel-select"
                  aria-label="New lead"
                  ref={(select) => requestAnimationFrame(() => select.focus())}
                  onChange={(event) => {
                    const lead = event.currentTarget.value;
                    setReassigning(false);
                    if (lead) void props.store.act(current(), "reassign", lead);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setReassigning(false);
                  }}
                  onBlur={() => setReassigning(false)}
                >
                  <option value="">Choose a lead</option>
                  <For
                    each={props.detail.members.filter(
                      (member) => member.threadId !== current().leadThreadId,
                    )}
                  >
                    {(member) => <option value={member.threadId}>{member.name}</option>}
                  </For>
                </select>
              </Show>
              <Show
                when={current().state === "stopped"}
                fallback={
                  <button type="button" class="channel-button" onClick={() => stop(current())}>
                    Stop
                  </button>
                }
              >
                <button
                  type="button"
                  class="channel-button"
                  onClick={() => void props.store.act(current(), "resume")}
                >
                  Resume
                </button>
              </Show>
            </div>
          </Show>
        </section>
      )}
    </Show>
  );
}

function Waiting(props: { detail: ChannelDetail }) {
  return (
    <Show when={props.detail.waiting.length > 0}>
      <section class="channel-waiting" aria-labelledby="channel-waiting-title">
        <h2 id="channel-waiting-title" class="channel-waiting-title">
          Waiting for replies
        </h2>
        <ul class="channel-panel-list">
          <For each={props.detail.waiting}>
            {(row) => (
              <li class="channel-waiting-row">
                <span class="task-dot task-dot-waiting" aria-hidden="true" />
                <span>
                  <strong>{row.name}</strong> owes {row.askedBy === "You" ? "you" : row.askedBy} a
                  reply
                </span>
                <time class="channel-post-time" dateTime={row.since}>
                  {shortTime(row.since)}
                </time>
              </li>
            )}
          </For>
        </ul>
      </section>
    </Show>
  );
}

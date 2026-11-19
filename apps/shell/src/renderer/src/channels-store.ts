import { createMemo, createSignal, onCleanup } from "solid-js";
import type {
  ChannelDetail,
  ChannelPostView,
  ChannelRequestActionName,
  ChannelRequestView,
  ChannelSummary,
} from "../../shared/channels";
import { mentionedMembers, optimisticPost, stateAfter } from "./channels";

/**
 * Team channels, kept current from main. The list and the open channel re-read after each
 * company change, at most once a frame. Posts and request actions show at once and roll back
 * with an error if the daemon refuses them.
 */
export function createChannelsStore() {
  const [channels, setChannels] = createSignal<ChannelSummary[]>([]);
  const [openId, setOpenId] = createSignal<string | null>(null);
  const [loaded, setLoaded] = createSignal<ChannelDetail | null>(null);
  const [sending, setSending] = createSignal<ChannelPostView[]>([]);
  const [acting, setActing] = createSignal<Record<string, ChannelRequestView>>({});
  const [error, setError] = createSignal("");
  let frame: number | undefined;
  let generation = 0;

  function refresh() {
    const current = ++generation;
    void window.openbot.agent
      .listChannels()
      .then((list) => {
        if (current === generation) setChannels(list);
      })
      .catch(() => undefined);
    const id = openId();
    if (!id) return;
    void window.openbot.agent
      .readChannel(id)
      .then((detail) => {
        if (current !== generation || openId() !== id) return;
        setLoaded(detail);
        const stored = new Set(detail.posts.map((post) => post.id));
        setSending((posts) => posts.filter((post) => !stored.has(post.id)));
        setActing((pending) => {
          const kept = Object.entries(pending).filter(([requestId, request]) =>
            detail.requests.some((row) => row.id === requestId && row.revision < request.revision),
          );
          return kept.length === Object.keys(pending).length ? pending : Object.fromEntries(kept);
        });
      })
      .catch(() => undefined);
  }

  function scheduleRefresh() {
    if (frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      refresh();
    });
  }

  const stop = window.openbot.agent.onEvent((event) => {
    if (
      event.type === "company-changed" ||
      (event.type === "status" && event.status.phase === "ready")
    )
      scheduleRefresh();
  });
  onCleanup(() => {
    stop();
    if (frame !== undefined) cancelAnimationFrame(frame);
  });
  refresh();

  /** The open channel with posts still sending and request actions still in flight. */
  const detail = createMemo((): ChannelDetail | null => {
    const base = loaded();
    if (!base || base.channel.id !== openId()) return null;
    const pending = acting();
    const extra = sending().filter((post) => !base.posts.some((row) => row.id === post.id));
    return {
      ...base,
      posts: extra.length ? [...base.posts, ...extra] : base.posts,
      requests: base.requests.map((request) => pending[request.id] ?? request),
    };
  });

  function open(channelId: string | null) {
    if (openId() === channelId) return;
    setOpenId(channelId);
    setError("");
    setSending([]);
    setActing({});
    if (channelId) refresh();
  }

  async function post(text: string): Promise<boolean> {
    const current = detail();
    const value = text.trim();
    if (!current || !value) return false;
    const postId = `post-${crypto.randomUUID()}`;
    const optimistic = optimisticPost(postId, value, current, new Date().toISOString());
    setError("");
    setSending((posts) => [...posts, optimistic]);
    try {
      await window.openbot.agent.postChannel({
        channelId: current.channel.id,
        postId,
        text: value,
        mentions: mentionedMembers(value, current.members),
      });
      scheduleRefresh();
      return true;
    } catch (cause) {
      setSending((posts) => posts.filter((row) => row.id !== postId));
      setError(messageOf(cause, "Couldn't send. Try again."));
      return false;
    }
  }

  async function act(
    request: ChannelRequestView,
    action: ChannelRequestActionName,
    leadThreadId?: string,
  ) {
    const lead = leadThreadId
      ? detail()?.members.find((member) => member.threadId === leadThreadId)
      : undefined;
    setError("");
    setActing((pending) => ({
      ...pending,
      [request.id]: {
        ...request,
        state: stateAfter(request, action),
        revision: request.revision + 1,
        ...(lead ? { leadThreadId: lead.threadId, leadName: lead.name } : {}),
      },
    }));
    try {
      await window.openbot.agent.channelRequest({
        requestId: request.id,
        action,
        revision: request.revision,
        ...(leadThreadId ? { leadThreadId } : {}),
      });
      scheduleRefresh();
    } catch (cause) {
      setActing((pending) => {
        const { [request.id]: _dropped, ...rest } = pending;
        return rest;
      });
      setError(messageOf(cause, "Couldn't update the request. Try again."));
    }
  }

  return {
    channels,
    openId,
    detail,
    error,
    open,
    post,
    act,
    clearError: () => setError(""),
  };
}

function messageOf(cause: unknown, fallback: string): string {
  const message = cause instanceof Error ? cause.message : "";
  if (message.includes("mention_not_member")) return "Mention someone in this channel.";
  if (message.includes("stale") || message.includes("revision"))
    return "The request changed. Try again.";
  return fallback;
}

export type ChannelsStore = ReturnType<typeof createChannelsStore>;

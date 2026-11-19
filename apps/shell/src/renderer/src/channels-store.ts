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
  /** Older posts loaded with Show earlier, oldest first, and whether still older ones exist. */
  const [earlier, setEarlier] = createSignal<ChannelPostView[]>([]);
  const [earlierMore, setEarlierMore] = createSignal<boolean | null>(null);
  const [loadingEarlier, setLoadingEarlier] = createSignal(false);
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
        // With earlier pages shown, posts that fall out of the newest page join them, so the
        // transcript keeps no gap.
        const previous = loaded();
        if (earlier().length && previous?.channel.id === id) {
          const kept = new Set(detail.posts.map((post) => post.id));
          const first = detail.posts[0]?.createdAt ?? "";
          const dropped = previous.posts.filter(
            (post) => !kept.has(post.id) && post.createdAt <= first,
          );
          if (dropped.length) setEarlier((posts) => [...posts, ...dropped]);
        }
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
    const older = earlier().filter((post) => !base.posts.some((row) => row.id === post.id));
    const more = earlierMore();
    return {
      ...base,
      posts: older.length || extra.length ? [...older, ...base.posts, ...extra] : base.posts,
      more: more === null ? base.more : more,
      requests: base.requests.map((request) => pending[request.id] ?? request),
    };
  });

  function open(channelId: string | null) {
    if (openId() === channelId) return;
    setOpenId(channelId);
    setError("");
    setSending([]);
    setActing({});
    setEarlier([]);
    setEarlierMore(null);
    setLoadingEarlier(false);
    if (channelId) refresh();
  }

  /** Loads the page of posts before the oldest one shown. */
  async function loadEarlier(): Promise<boolean> {
    const current = detail();
    const first = current?.posts[0];
    if (!current || !first || !current.more || loadingEarlier()) return false;
    const channelId = current.channel.id;
    setLoadingEarlier(true);
    setError("");
    try {
      const page = await window.openbot.agent.readEarlierPosts({ channelId, before: first.id });
      if (openId() !== channelId) return false;
      setEarlier((posts) => [
        ...page.posts.filter((post) => !posts.some((row) => row.id === post.id)),
        ...posts,
      ]);
      setEarlierMore(page.more);
      return true;
    } catch {
      if (openId() === channelId) setError("Couldn't load earlier posts. Try again.");
      return false;
    } finally {
      if (openId() === channelId) setLoadingEarlier(false);
    }
  }

  async function post(text: string): Promise<boolean> {
    const current = detail();
    const value = text.trim();
    if (!current || !value) return false;
    // randomUUID needs a secure context, which the renderer's page may not be.
    const postId = `post-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
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
    loadEarlier,
    loadingEarlier,
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

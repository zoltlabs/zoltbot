import type { ChannelPost, ChannelRead, ChannelRequestAction } from "@zoltbot/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActionSheetIOS, Alert } from "react-native";
import {
  type ChannelPostView,
  type ChannelRequestView,
  type ChannelView,
  channelError,
  channelKinds,
  channelTranscript,
  leadChoices,
  mentionedMembers,
  mergePosts,
  newPostId,
  sendingPost,
  stopConfirmation,
  toChannelView,
  toPostView,
} from "../data/channels";
import { attempts } from "./actions";
import { useClient, useLink, useSnapshot } from "./link";

/**
 * One team channel, kept current from the Mac: it re-reads after each change to the channel's
 * rows and when the link comes back. Posts show at once and roll back with an alert if the Mac
 * refuses them. Each post keeps its id until it lands, so a retry never posts twice.
 */
export function useChannel(id: string) {
  const client = useLink((state) => state.client);
  const snapshot = useSnapshot();
  const online = useClient((state) => state.status === "online");
  const [read, setRead] = useState<ChannelRead | null>(null);
  const [failed, setFailed] = useState("");
  /** Older pages loaded with Show earlier, oldest first. */
  const [earlier, setEarlier] = useState<ChannelPost[]>([]);
  const [earlierMore, setEarlierMore] = useState<boolean | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [sending, setSending] = useState<ChannelPostView[]>([]);
  const [acting, setActing] = useState<string | null>(null);
  const generation = useRef(0);
  const current = useRef<ChannelRead | null>(null);
  const attempt = useRef<{ id: string; text: string } | null>(null);
  const paged = useRef(false);

  const call = useCallback(
    (method: string, params: unknown, commandId?: string) => {
      if (!client) return Promise.reject(new Error("Not connected to your Mac."));
      return client.getState().call(method, params, commandId);
    },
    [client],
  );

  const refresh = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const next = (await call("channel.read", { id })) as ChannelRead;
      if (mine !== generation.current) return;
      // With earlier pages shown, posts that fall out of the newest page join them, so the
      // transcript keeps no gap.
      const previous = current.current;
      if (previous && previous.channel.id === id) {
        const kept = new Set(next.posts.map((post) => post.id));
        const first = next.posts[0]?.createdAt ?? "";
        const dropped = previous.posts.filter(
          (post) => !kept.has(post.id) && post.createdAt <= first,
        );
        if (dropped.length && paged.current) setEarlier((posts) => [...posts, ...dropped]);
      }
      current.current = next;
      setRead(next);
      setFailed("");
      const stored = new Set(next.posts.map((post) => post.id));
      setSending((posts) => posts.filter((post) => !stored.has(post.id)));
    } catch (cause) {
      if (mine === generation.current) setFailed(channelError(cause, "Couldn't load the channel."));
    }
  }, [call, id]);

  useEffect(() => {
    if (online) void refresh();
  }, [online, refresh]);

  // Many rows change at once (a post, its request, its messages); read once after them.
  useEffect(() => {
    if (!client) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = client.onEvent((event) => {
      if (!channelKinds.has(event.aggregateType) || timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void refresh();
      }, 120);
    });
    return () => {
      stop();
      if (timer) clearTimeout(timer);
    };
  }, [client, refresh]);

  const view = useMemo((): ChannelView | null => {
    if (!read || read.channel.id !== id) return null;
    const base = toChannelView(snapshot, read);
    return {
      ...base,
      posts: mergePosts(
        earlier.map((post) => toPostView(snapshot, post)),
        base.posts,
        sending,
      ),
      more: earlierMore ?? base.more,
    };
  }, [snapshot, read, id, earlier, earlierMore, sending]);
  const transcript = useMemo(() => (view ? channelTranscript(view) : []), [view]);

  /** Loads the page of posts before the oldest one shown. */
  const loadEarlier = useCallback(async () => {
    const first = view?.posts.find((post) => !post.sending);
    if (!view?.more || !first || loadingEarlier) return;
    setLoadingEarlier(true);
    try {
      const page = (await call("channel.read", { id, before: first.id })) as ChannelRead;
      setEarlier((posts) => [
        ...page.posts.filter((post) => !posts.some((row) => row.id === post.id)),
        ...posts,
      ]);
      paged.current = true;
      setEarlierMore(page.more);
    } catch (cause) {
      Alert.alert("Couldn't load earlier posts", channelError(cause, "Try again."));
    } finally {
      setLoadingEarlier(false);
    }
  }, [call, id, view, loadingEarlier]);

  /** Posts the owner's message. Resolves false when it did not go through. */
  const post = useCallback(
    async (value: string): Promise<boolean> => {
      const body = value.trim();
      if (!view || !body) return false;
      const postId = attempt.current?.text === body ? attempt.current.id : newPostId();
      attempt.current = { id: postId, text: body };
      const mentions = mentionedMembers(body, view.members);
      setSending((posts) => [
        ...posts.filter((row) => row.id !== postId),
        sendingPost(postId, body, view.members, new Date().toISOString()),
      ]);
      const params = {
        channelId: view.id,
        id: postId,
        text: body,
        ...(mentions.length ? { mentions } : {}),
      };
      try {
        await attempts.run(`channel.post:${postId}`, params, (sent, commandId) =>
          call("channel.post", sent, commandId),
        );
        attempt.current = null;
        void refresh();
        return true;
      } catch (cause) {
        setSending((posts) => posts.filter((row) => row.id !== postId));
        Alert.alert("Couldn't send", channelError(cause, "Try again."));
        return false;
      }
    },
    [call, refresh, view],
  );

  const act = useCallback(
    async (request: ChannelRequestView, action: ChannelRequestAction, leadThreadId?: string) => {
      const params = {
        id: request.id,
        action,
        revision: request.revision,
        ...(leadThreadId ? { leadThreadId } : {}),
        // Only sent after the person confirmed Stop.
        ...(action === "stop" ? { confirmed: true } : {}),
      };
      setActing(request.id);
      try {
        await attempts.run(
          `channel.request:${request.id}:${request.revision}:${action}`,
          params,
          (sent, commandId) => call("channel.request", sent, commandId),
        );
        void refresh();
      } catch (cause) {
        Alert.alert("Couldn't update the request", channelError(cause, "Try again."));
        void refresh();
      } finally {
        setActing(null);
      }
    },
    [call, refresh],
  );

  /** Stop asks first when it would cancel tasks. */
  const stop = useCallback(
    (request: ChannelRequestView) => {
      const confirm = stopConfirmation(request);
      if (!confirm) {
        void act(request, "stop");
        return;
      }
      Alert.alert(confirm.title, confirm.message, [
        { text: "Cancel", style: "cancel" },
        { text: "Stop request", style: "destructive", onPress: () => void act(request, "stop") },
      ]);
    },
    [act],
  );

  /** Picks another member to lead the request. */
  const reassign = useCallback(
    (request: ChannelRequestView) => {
      const choices = leadChoices(view?.members ?? [], request);
      if (!choices.length) return;
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: "New lead",
          options: [...choices.map((member) => member.name), "Cancel"],
          cancelButtonIndex: choices.length,
        },
        (index) => {
          const member = choices[index];
          if (member) void act(request, "reassign", member.threadId);
        },
      );
    },
    [act, view?.members],
  );

  const perform = useCallback(
    (request: ChannelRequestView, action: ChannelRequestAction) => {
      if (action === "stop") stop(request);
      else if (action === "reassign") reassign(request);
      else void act(request, action);
    },
    [act, reassign, stop],
  );

  return {
    view,
    transcript,
    online,
    failed,
    loadEarlier,
    loadingEarlier,
    post,
    perform,
    acting,
    retry: refresh,
  };
}

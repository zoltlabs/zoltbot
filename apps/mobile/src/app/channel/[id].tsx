import { router, useLocalSearchParams } from "expo-router";
import { type ComponentRef, useEffect, useRef } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { currentRequest, requestMeta } from "../../data/channels";
import { useChannel } from "../../state/channel";
import { touch, useTheme } from "../../theme";
import { ChannelComposer } from "../../ui/channel/ChannelComposer";
import {
  HeaderButton,
  Notice,
  PostRow,
  RequestBar,
  WaitingBlock,
} from "../../ui/channel/ChannelParts";
import { OfflineBanner } from "../../ui/chrome";
import { Icon } from "../../ui/icons";
import { Button, Txt } from "../../ui/kit";

/** A team channel: the owner's posts, the team's replies, task events and open questions. */
export default function ChannelScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const channel = useChannel(id);
  const { view, transcript } = channel;
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const request = view ? currentRequest(view.requests) : null;
  const name = view ? `#${view.name}` : "";
  const openInfo = () => router.push({ pathname: "/channel/info", params: { id } });

  // Keep the newest post in view as posts arrive. Earlier posts loaded above don't move it.
  const last = transcript.at(-1)?.key;
  useEffect(() => {
    if (last) requestAnimationFrame(() => scroll.current?.scrollToEnd({ animated: false }));
  }, [last]);

  return (
    <KeyboardAvoidingView
      behavior="padding"
      style={[styles.page, { backgroundColor: c["bg-page"] }]}
    >
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <HeaderButton
          label="Back"
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
        >
          <Icon name="back" color={c.text} size={20} stroke={1.8} />
        </HeaderButton>
        <Pressable
          onPress={openInfo}
          disabled={!view}
          accessibilityRole="button"
          accessibilityLabel={name || "Channel"}
          accessibilityHint="Opens requests and members"
          style={styles.title}
        >
          <Txt v="cardTitle" lines={1} accessibilityRole="header">
            {name}
          </Txt>
        </Pressable>
        <HeaderButton label="Members and requests" onPress={openInfo}>
          <Icon name="members" color={c.text} size={20} stroke={1.8} />
        </HeaderButton>
      </View>
      <View style={styles.banner}>
        <OfflineBanner />
      </View>
      {request ? (
        <RequestBar
          request={request}
          meta={requestMeta(request)}
          onOpen={openInfo}
          onStop={() => channel.perform(request, "stop")}
          disabled={!channel.online || channel.acting === request.id}
        />
      ) : null}
      {view ? (
        <ScrollView
          ref={scroll}
          style={styles.grow}
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        >
          {view.more ? (
            <Button
              kind="plain"
              label={channel.loadingEarlier ? "Loading…" : "Show earlier"}
              disabled={channel.loadingEarlier || !channel.online}
              onPress={() => void channel.loadEarlier()}
            />
          ) : null}
          {transcript.length === 0 ? (
            <Txt tone="muted" style={styles.empty}>
              No posts yet.
            </Txt>
          ) : null}
          {transcript.map((entry) =>
            entry.kind === "post" ? (
              <PostRow
                key={entry.key}
                post={entry.post}
                members={view.members}
                leadThreadId={view.leadThreadId}
              />
            ) : (
              <Notice key={entry.key} text={entry.text} />
            ),
          )}
          <WaitingBlock rows={view.waiting} />
        </ScrollView>
      ) : (
        <View style={[styles.grow, styles.center]}>
          {channel.failed ? (
            <>
              <Txt tone="secondary" style={styles.empty}>
                {channel.failed}
              </Txt>
              <Button
                label="Try again"
                disabled={!channel.online}
                onPress={() => void channel.retry()}
              />
            </>
          ) : channel.online ? (
            <ActivityIndicator color={c["text-muted"]} accessibilityLabel="Loading" />
          ) : null}
        </View>
      )}
      {view?.archived ? (
        <Txt tone="muted" style={[styles.archived, { paddingBottom: Math.max(insets.bottom, 12) }]}>
          This channel is archived.
        </Txt>
      ) : (
        <ChannelComposer
          channelName={view?.name ?? ""}
          members={view?.members ?? []}
          disabled={!view || !channel.online}
          bottom={Math.max(insets.bottom, 12)}
          onSend={channel.post}
        />
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  title: { flex: 1, minHeight: touch, alignItems: "center", justifyContent: "center" },
  banner: { paddingHorizontal: 16 },
  grow: { flex: 1 },
  center: { alignItems: "center", justifyContent: "center", gap: 12, padding: 24 },
  body: { paddingHorizontal: 16, paddingTop: 18, paddingBottom: 8, gap: 18 },
  empty: { textAlign: "center" },
  archived: { textAlign: "center", paddingTop: 12, paddingHorizontal: 24 },
});

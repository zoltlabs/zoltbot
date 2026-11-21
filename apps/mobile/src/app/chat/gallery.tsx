import { router, useLocalSearchParams } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  Image,
  Platform,
  Pressable,
  ScrollView,
  Share,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { loadAttachmentPreview, previewProblem } from "../../data/attachment-preview";
import { chatPictures } from "../../data/timeline";
import { useClient, useLink, useSnapshot } from "../../state/link";
import { Txt } from "../../ui/kit";

type Picture = { itemId: string; part: number; name: string };
type Loaded = { uri: string } | { problem: string };

/** One picture, loaded from the Mac when its page comes near; pinch zooms it. */
function Page({
  picture,
  threadId,
  width,
  near,
  onLoaded,
}: {
  picture: Picture;
  threadId: string;
  width: number;
  near: boolean;
  onLoaded: (uri: string) => void;
}) {
  const online = useClient((s) => s.status === "online");
  const [loaded, setLoaded] = useState<Loaded>();
  // The parent passes a new callback each render; a ref keeps the load from restarting.
  const report = useRef(onLoaded);
  report.current = onLoaded;
  useEffect(() => {
    const client = useLink.getState().client;
    if (!near || loaded || !online || !client) return;
    let live = true;
    loadAttachmentPreview((method, p) => client.getState().call(method, p), {
      threadId,
      itemId: picture.itemId,
      part: picture.part,
    })
      .then((preview) => {
        if (!live) return;
        if (preview.kind !== "image") return setLoaded({ problem: "Can't show this picture." });
        setLoaded({ uri: preview.uri });
        report.current(preview.uri);
      })
      .catch((error) => {
        if (live) setLoaded({ problem: previewProblem(error) });
      });
    return () => {
      live = false;
    };
  }, [near, loaded, online, threadId, picture.itemId, picture.part]);
  return (
    <ScrollView
      style={{ width }}
      contentContainerStyle={{ flexGrow: 1, alignItems: "center", justifyContent: "center" }}
      maximumZoomScale={4}
      minimumZoomScale={1}
      centerContent
      showsHorizontalScrollIndicator={false}
      showsVerticalScrollIndicator={false}
    >
      {loaded && "uri" in loaded ? (
        <Image
          source={{ uri: loaded.uri }}
          accessible
          accessibilityLabel={picture.name}
          resizeMode="contain"
          style={{ width, height: "100%", minHeight: 300 }}
        />
      ) : (
        <Txt style={{ color: "#fff", padding: 24 }}>
          {!online
            ? "Reconnect to your Mac to load this picture."
            : loaded && "problem" in loaded
              ? loaded.problem
              : "Loading…"}
        </Txt>
      )}
    </ScrollView>
  );
}

/** C17: every picture in the chat, full screen. Swipe between them; pinch to zoom. */
export default function GalleryScreen() {
  const params = useLocalSearchParams<{ id: string; item: string; part: string }>();
  const snapshot = useSnapshot();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const pictures = useMemo(() => chatPictures(snapshot, params.id), [snapshot, params.id]);
  const key = (p: Picture) => `${p.itemId}:${p.part}`;
  // The picture shown, by key: the list can arrive late or shift when a message is hidden.
  const [shown, setShown] = useState(`${params.item}:${params.part}`);
  const index = Math.max(
    0,
    pictures.findIndex((p) => key(p) === shown),
  );
  const uris = useRef(new Map<string, string>());
  const current = pictures[index];
  const list = useRef<FlatList<Picture>>(null);
  // A turned phone or a shifted list moves pages; keep the same picture in view.
  useEffect(() => {
    if (pictures.length && width) list.current?.scrollToIndex({ index, animated: false });
  }, [width, index, pictures.length]);

  // Re-render when a picture arrives, so Share knows it can share the current one.
  const [, setArrived] = useState(0);
  const shareable = current ? uris.current.get(key(current)) : undefined;
  const share = () => {
    if (shareable) void Share.share({ url: shareable });
  };
  const target = { minHeight: 44, minWidth: 44, justifyContent: "center" as const };

  return (
    <View style={{ flex: 1, backgroundColor: "#000", paddingTop: insets.top }}>
      <StatusBar style="light" />
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: 16,
          minHeight: 44,
        }}
      >
        <Pressable
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
          accessibilityRole="button"
          style={target}
        >
          <Txt v="bodyMedium" style={{ color: "#fff" }}>
            Done
          </Txt>
        </Pressable>
        <View accessibilityLiveRegion="polite">
          <Txt v="bodyMedium" style={{ color: "#fff", fontVariant: ["tabular-nums"] }}>
            {pictures.length ? `${index + 1} of ${pictures.length}` : ""}
          </Txt>
        </View>
        {/* Android's share sheet takes text, not a picture's data, so Share is iPhone only. */}
        {Platform.OS === "ios" ? (
          <Pressable
            onPress={share}
            disabled={!shareable}
            accessibilityRole="button"
            accessibilityLabel={current ? `Share ${current.name}` : "Share"}
            accessibilityState={{ disabled: !shareable }}
            style={[target, { alignItems: "flex-end", opacity: shareable ? 1 : 0.5 }]}
          >
            <Txt v="bodyMedium" style={{ color: "#fff" }}>
              Share
            </Txt>
          </Pressable>
        ) : (
          <View style={target} />
        )}
      </View>
      {pictures.length ? (
        <FlatList
          data={pictures}
          keyExtractor={key}
          horizontal
          pagingEnabled
          ref={list}
          initialScrollIndex={index}
          getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={(event) => {
            const page = pictures[Math.round(event.nativeEvent.contentOffset.x / width)];
            if (page) setShown(key(page));
          }}
          renderItem={({ item, index: i }) => (
            <Page
              picture={item}
              threadId={params.id}
              width={width}
              near={Math.abs(i - index) <= 1}
              onLoaded={(uri) => {
                uris.current.set(key(item), uri);
                setArrived((n) => n + 1);
              }}
            />
          )}
        />
      ) : (
        <Txt style={{ color: "#fff", padding: 24 }}>This picture is no longer in the chat.</Txt>
      )}
      <View style={{ height: insets.bottom }} />
    </View>
  );
}

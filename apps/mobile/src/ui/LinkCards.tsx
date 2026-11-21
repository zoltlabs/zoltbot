// C15: cards for up to two links in a message: the page's picture, site and title.
import { useEffect, useState } from "react";
import { Image, Linking, Pressable, StyleSheet, View } from "react-native";
import { cardLinks, type LinkCard, loadLinkCard } from "../data/link-preview";
import { useClient, useLink } from "../state/link";
import { useTheme } from "../theme";
import { Txt } from "./kit";

export function LinkCards({
  threadId,
  itemId,
  text,
  align = "flex-start",
}: {
  threadId?: string | undefined;
  itemId: string;
  text: string;
  /** The owner's messages sit on the right. */
  align?: "flex-start" | "flex-end";
}) {
  const links = cardLinks(text);
  if (!threadId || !links.length) return null;
  return (
    <View style={[styles.list, { alignSelf: align }]}>
      {links.map((url) => (
        <OneCard key={url} threadId={threadId} itemId={itemId} url={url} />
      ))}
    </View>
  );
}

function OneCard({ threadId, itemId, url }: { threadId: string; itemId: string; url: string }) {
  const { c } = useTheme();
  const online = useClient((s) => s.status === "online");
  const [card, setCard] = useState<LinkCard | null>(null);
  useEffect(() => {
    const client = useLink.getState().client;
    if (!online || !client) return;
    let live = true;
    void loadLinkCard((method, p) => client.getState().call(method, p), {
      threadId,
      itemId,
      url,
    }).then((found) => {
      if (live) setCard(found);
    });
    return () => {
      live = false;
    };
  }, [online, threadId, itemId, url]);
  if (!card) return null;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`${card.title}, ${card.siteName}`}
      onPress={() => void Linking.openURL(card.url).catch(() => undefined)}
      style={({ pressed }) => [
        styles.card,
        {
          borderColor: c.border,
          backgroundColor: pressed ? c["bg-hover"] : c["bg-raised"],
          borderRadius: c["radius-md"],
        },
      ]}
    >
      {card.image ? (
        <Image
          source={{ uri: card.image }}
          style={[styles.picture, { borderRadius: c["radius-sm"] }]}
          accessibilityIgnoresInvertColors
        />
      ) : null}
      <View style={styles.copy}>
        <Txt v="meta" tone="secondary" lines={1}>
          {card.siteName}
        </Txt>
        <Txt v="bodyMedium" lines={1}>
          {card.title}
        </Txt>
        {card.description ? (
          <Txt v="meta" tone="secondary" lines={1}>
            {card.description}
          </Txt>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  list: { gap: 6, maxWidth: 360 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  picture: { width: 48, height: 48 },
  copy: { flex: 1, minWidth: 0, gap: 1 },
});

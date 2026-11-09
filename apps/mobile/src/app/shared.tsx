import { router } from "expo-router";
import { Alert, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { sharingAvailable, useSharing } from "../state/sharing";
import { useTheme } from "../theme";
import { BackBar } from "../ui/chrome";
import { Button, Group, Row, Txt } from "../ui/kit";

export default function SharedInbox() {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const drafts = useSharing((state) => state.drafts);
  const error = useSharing((state) => state.error);
  return (
    <View style={{ flex: 1, backgroundColor: c["bg-page"], paddingTop: insets.top }}>
      <BackBar label="Chats" />
      <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }}>
        <Txt v="cardTitle" accessibilityRole="header">
          Shared drafts
        </Txt>
        <Txt tone="muted">
          Review a saved share and send it to a bot. Drafts stay on this iPhone until sent or
          discarded.
        </Txt>
        {!sharingAvailable ? (
          <Txt>Sharing requires an iOS development or production build.</Txt>
        ) : null}
        {error ? (
          <Button
            label="Retry loading drafts"
            onPress={() => {
              void useSharing
                .getState()
                .refresh()
                .then(() => {
                  const latest = useSharing.getState().error;
                  if (latest) Alert.alert("Could not load drafts", latest);
                });
            }}
          />
        ) : null}
        {error ? <Txt tone="muted">{error}</Txt> : null}
        {drafts.length ? (
          <Group>
            {drafts.map((draft, index) => (
              <Row
                key={draft.id}
                title={draft.text.trim() || "Shared photos"}
                meta={`${draft.images.length} photos · ${new Date(draft.createdAt).toLocaleString()}`}
                last={index === drafts.length - 1}
                onPress={() => router.push({ pathname: "/shared/[id]", params: { id: draft.id } })}
              />
            ))}
          </Group>
        ) : (
          <Txt tone="muted">
            No shared drafts. Choose Zoltbot in another app’s share sheet to save one.
          </Txt>
        )}
      </ScrollView>
    </View>
  );
}

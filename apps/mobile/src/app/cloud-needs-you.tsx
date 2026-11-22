import { router, useLocalSearchParams } from "expo-router";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCloud } from "../state/cloud";
import { useLink } from "../state/link";
import { useTheme } from "../theme";
import { BackBar } from "../ui/chrome";
import { CloudNeedsYou } from "../ui/cloud/NeedsYou";
import { Button, Txt } from "../ui/kit";

export default function CloudNeedsYouScreen() {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams();
  const client = useLink((state) => state.client);
  const signedIn = useCloud((state) => state.account.signedIn);

  const scoped =
    typeof params.orgId === "string" && typeof params.threadId === "string"
      ? { orgId: params.orgId, threadId: params.threadId }
      : {};
  return (
    <View style={[styles.page, { backgroundColor: c["bg-page"], paddingTop: insets.top }]}>
      {router.canGoBack() ? <BackBar label="Zoltbot" /> : null}
      <ScrollView
        contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 16 }]}
        keyboardShouldPersistTaps="handled"
      >
        <Txt v="largeTitle" accessibilityRole="header">
          Cloud Needs you
        </Txt>
        <CloudNeedsYou {...scoped} standalone />
        {signedIn ? (
          <Button label="Cloud account" onPress={() => router.push("/cloud-account")} />
        ) : null}
        {client ? (
          <Button label="Open paired Mac" onPress={() => router.replace("/")} />
        ) : (
          <Button label="Pair with a Mac" onPress={() => router.push("/pair")} />
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  body: { paddingHorizontal: 16, paddingTop: 12, gap: 12 },
});

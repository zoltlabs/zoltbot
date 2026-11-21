import { useEffect } from "react";
import { Modal, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { nativeLock, useAppLock } from "../state/app-lock";
import { useTheme } from "../theme";
import { Logo } from "./icons";
import { Button, Txt } from "./kit";

/** Covers the app while it is locked when the native cover isn't built in. */
export function LockScreen() {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const { locked, covered, unlock } = useAppLock();
  useEffect(() => {
    if (locked) void unlock();
  }, [locked, unlock]);
  // The native cover sits above everything; this Modal only stands in without it (Expo Go).
  if (nativeLock) return null;
  return (
    <Modal visible={covered || locked} animationType="none" onRequestClose={() => undefined}>
      <View
        accessibilityViewIsModal
        style={[styles.page, { backgroundColor: c["bg-page"], paddingBottom: insets.bottom + 24 }]}
      >
        <View style={styles.logo} accessible={false}>
          <Logo />
          {locked ? (
            <Txt v="cardTitle" accessibilityRole="header" style={styles.title}>
              Zoltbot is locked
            </Txt>
          ) : null}
        </View>
        {locked ? (
          <Button
            label="Unlock"
            kind="primary"
            onPress={() => void unlock()}
            style={styles.button}
          />
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, alignItems: "center", justifyContent: "center" },
  logo: { flex: 1, justifyContent: "center", alignItems: "center" },
  title: { marginTop: 16 },
  button: { alignSelf: "stretch", marginHorizontal: 24 },
});

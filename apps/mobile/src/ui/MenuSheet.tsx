// P10: the sheet `showMenu` opens on Android for menus too long for an alert.
import { useEffect, useSyncExternalStore } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { t } from "../i18n";
import { useAppLock } from "../state/app-lock";
import { touch, useTheme } from "../theme";
import { Txt } from "./kit";
import { menuSheet, openMenuSheet } from "./menu-sheet-store";

export function MenuSheet() {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const menu = useSyncExternalStore(menuSheet.subscribe, menuSheet.get);
  const locked = useAppLock((state) => state.locked);
  const close = () => openMenuSheet(undefined);
  // Locking hides what was open, menus included.
  useEffect(() => {
    if (locked) openMenuSheet(undefined);
  }, [locked]);
  const row = [styles.row, { borderTopColor: c.border }];
  return (
    <Modal
      visible={!!menu && !locked}
      transparent
      statusBarTranslucent
      animationType="slide"
      onRequestClose={close}
    >
      <Pressable
        style={[styles.scrim, { backgroundColor: c.scrim }]}
        onPress={close}
        accessible={false}
        importantForAccessibility="no"
      />
      <View
        accessibilityViewIsModal
        style={[
          styles.panel,
          { backgroundColor: c["bg-raised"], paddingBottom: insets.bottom + 8 },
        ]}
      >
        {menu?.title ? (
          <Txt v="meta" tone="muted" accessibilityRole="header" style={styles.title}>
            {menu.title}
          </Txt>
        ) : null}
        {menu?.message ? (
          <Txt v="meta" tone="muted" style={styles.message}>
            {menu.message}
          </Txt>
        ) : null}
        <ScrollView style={styles.list}>
          {menu?.items
            .filter((item) => !item.disabled)
            .map((item, index) => (
              <Pressable
                // biome-ignore lint/suspicious/noArrayIndexKey: labels can repeat; the list is fixed while open.
                key={index}
                accessibilityRole="button"
                onPress={() => {
                  close();
                  item.onPress();
                }}
                style={({ pressed }) => [...row, pressed && { backgroundColor: c["bg-hover"] }]}
              >
                <Txt tone={item.destructive ? "danger" : "text"}>{item.label}</Txt>
              </Pressable>
            ))}
        </ScrollView>
        <Pressable accessibilityRole="button" onPress={close} style={row}>
          <Txt tone="secondary">{t("kit.cancel")}</Txt>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1 },
  panel: { borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingTop: 8, maxHeight: "70%" },
  title: { paddingHorizontal: 20, paddingVertical: 10 },
  message: { paddingHorizontal: 20, paddingBottom: 10, marginTop: -4 },
  list: { flexGrow: 0 },
  row: {
    minHeight: touch + 8,
    justifyContent: "center",
    paddingHorizontal: 20,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});

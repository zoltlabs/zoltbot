// The sheet `showPrompt` opens on Android, which has no text prompt of its own.
import { useEffect, useState, useSyncExternalStore } from "react";
import { KeyboardAvoidingView, Modal, Pressable, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { t } from "../i18n";
import { useAppLock } from "../state/app-lock";
import { sans, useTheme } from "../theme";
import { Button, Txt } from "./kit";
import { type OpenPrompt, openPromptSheet, promptSheet } from "./prompt-sheet-store";

export function PromptSheet() {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const prompt = useSyncExternalStore(promptSheet.subscribe, promptSheet.get);
  const locked = useAppLock((state) => state.locked);
  // The text typed, kept with the prompt it was typed into: a new prompt starts from its own text.
  const [typed, setTyped] = useState<{ for?: OpenPrompt; text: string }>({ text: "" });
  const value = typed.for === prompt ? typed.text : (prompt?.defaultValue ?? "");
  const setValue = (text: string) => setTyped({ for: prompt, text });
  const close = () => openPromptSheet(undefined);
  // Locking hides what was open, prompts included.
  useEffect(() => {
    if (locked) openPromptSheet(undefined);
  }, [locked]);
  const empty = !prompt?.optional && !value.trim();
  const submit = () => {
    // Read the store, not this render: a second tap before the sheet closes finds nothing open.
    const open = promptSheet.get();
    if (!open || open !== prompt || empty) return;
    close();
    open.onSubmit(value);
  };
  return (
    <Modal
      visible={!!prompt && !locked}
      transparent
      statusBarTranslucent
      animationType="slide"
      onRequestClose={close}
    >
      <KeyboardAvoidingView style={styles.fill} behavior="height">
        <Pressable
          style={[styles.fill, { backgroundColor: c.scrim }]}
          onPress={close}
          accessible={false}
          importantForAccessibility="no"
        />
        <View
          accessibilityViewIsModal
          style={[
            styles.panel,
            { backgroundColor: c["bg-raised"], paddingBottom: insets.bottom + 16 },
          ]}
        >
          <Txt v="cardTitle" accessibilityRole="header">
            {prompt?.title}
          </Txt>
          {prompt?.message ? <Txt tone="secondary">{prompt.message}</Txt> : null}
          <TextInput
            value={value}
            onChangeText={setValue}
            autoFocus
            onSubmitEditing={submit}
            accessibilityLabel={prompt?.message ?? prompt?.title}
            style={[
              styles.input,
              { color: c.text, borderColor: c["border-strong"], backgroundColor: c["bg-page"] },
            ]}
          />
          <View style={styles.actions}>
            <Button label={t("kit.cancel")} kind="plain" onPress={close} />
            <Button
              label={prompt?.confirmLabel ?? ""}
              kind="primary"
              disabled={empty}
              onPress={submit}
            />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  panel: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingTop: 20,
    paddingHorizontal: 20,
    gap: 12,
  },
  input: {
    fontFamily: sans,
    minHeight: 44,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 16,
  },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
});

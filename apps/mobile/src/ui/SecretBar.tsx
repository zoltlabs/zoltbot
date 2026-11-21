// V4: a message that looks like it holds a password or key waits above the composer, as on the
// Mac. Save to vault sends the secret over the paired link to the Mac's keychain and puts a
// reference like "[vault: API key]" in the message; Send anyway sends it as written.
import type { SecretMatch } from "@zoltbot/protocol";
import { useEffect, useState } from "react";
import { AccessibilityInfo, StyleSheet, TextInput, View } from "react-native";
import { sans, touch, useTheme } from "../theme";
import { Button, Txt } from "./kit";

const NAMES: Record<SecretMatch["kind"], string> = {
  api_key: "API key",
  token: "Token",
  password: "Password",
  private_key: "Private key",
};

export function SecretBar({
  match,
  busy,
  online,
  onSave,
  onSendAnyway,
}: {
  match: SecretMatch;
  busy: boolean;
  online: boolean;
  onSave: (label: string) => void;
  onSendAnyway: () => void;
}) {
  const { c } = useTheme();
  const [name, setName] = useState(NAMES[match.kind]);
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility("This looks like a secret.");
  }, []);
  return (
    <View
      style={[styles.bar, { borderColor: c.attention, backgroundColor: c["attention-soft"] }]}
      accessibilityRole="summary"
    >
      <Txt v="meta">This looks like a secret.</Txt>
      <TextInput
        value={name}
        onChangeText={setName}
        maxLength={80}
        autoCorrect={false}
        accessibilityLabel="Save as"
        style={[
          styles.name,
          { color: c.text, borderColor: c["border-strong"], backgroundColor: c["bg-raised"] },
        ]}
      />
      {online ? null : (
        <Txt v="meta" tone="secondary">
          Saving needs your Mac.
        </Txt>
      )}
      <View style={styles.actions}>
        <Button
          label="Save to vault"
          kind="primary"
          disabled={busy || !online || !name.trim()}
          onPress={() => onSave(name.trim())}
        />
        <Button label="Send anyway" disabled={busy} onPress={onSendAnyway} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { gap: 8, borderWidth: 1, borderRadius: 10, padding: 10 },
  name: {
    minHeight: touch,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontFamily: sans,
  },
  actions: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
});

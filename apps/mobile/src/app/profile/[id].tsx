import {
  DEFAULT_TALKING_STYLE_KEY,
  effectiveTalkingStyle,
  type TalkingStyle,
} from "@zoltbot/protocol";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import {
  ActionSheetIOS,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  TextInput,
  View,
} from "react-native";
import { offersFastMode } from "../../data/session";
import { definitionName, text } from "../../data/view";
import { t } from "../../i18n";
import { useAction } from "../../state/actions";
import { useClient, useSnapshot } from "../../state/link";
import { touch, useTheme } from "../../theme";
import { Icon } from "../../ui/icons";
import { Avatar, Button, Segmented, Txt } from "../../ui/kit";

/** The profile editor sheet, opened from Projects › Profiles. */
export default function ProfileSheet() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { c } = useTheme();
  const snapshot = useSnapshot();
  const online = useClient((state) => state.status === "online");
  const { run, busy } = useAction();
  const profile = (snapshot.entities.agent ?? []).find((row) => row.id === id);
  const definitions = snapshot.entities.agentDefinition ?? [];
  const [name, setName] = useState(text(profile?.name));
  const [definitionId, setDefinitionId] = useState(text(profile?.definitionId));
  const [model, setModel] = useState(text(profile?.model));
  const [instructions, setInstructions] = useState(text(profile?.instructions));
  // The owner's default applies until they pick a style for this agent.
  const [initialStyle] = useState<TalkingStyle>(() =>
    effectiveTalkingStyle(
      profile?.style,
      (snapshot.entities.settings ?? []).find((row) => row.key === DEFAULT_TALKING_STYLE_KEY)
        ?.value,
    ),
  );
  const [style, setStyle] = useState(initialStyle);
  const [fastMode, setFastMode] = useState(profile?.fastMode === true);
  if (!profile) return null;
  const fastOffered = offersFastMode(snapshot, id);

  const pickTool = () => {
    const labels = definitions.map((row) => text(row.displayName));
    ActionSheetIOS.showActionSheetWithOptions(
      { options: [...labels, "Cancel"], cancelButtonIndex: labels.length, title: "Coding tool" },
      (index) => {
        const row = definitions[index];
        if (row) setDefinitionId(text(row.id));
      },
    );
  };
  const save = async () => {
    const saved = await run("agent.update", {
      id,
      changes: {
        name: name.trim(),
        definitionId,
        instructions,
        ...(style !== initialStyle ? { style } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(fastOffered ? { fastMode } : {}),
      },
    });
    if (saved) router.back();
  };
  const field = [
    styles.input,
    { color: c.text, borderColor: c["border-strong"], backgroundColor: c["bg-raised"] },
  ];
  return (
    <ScrollView
      style={{ backgroundColor: c["bg-page"] }}
      contentContainerStyle={styles.body}
      keyboardShouldPersistTaps="handled"
      accessibilityLabel="Edit profile"
    >
      <View style={styles.bar}>
        <Button
          kind="plain"
          label="Cancel"
          onPress={() => router.back()}
          style={styles.barButton}
        />
        <Txt v="cardTitle" accessibilityRole="header">
          Edit profile
        </Txt>
        <Button
          kind="plain"
          label="Save"
          disabled={!online || busy || !name.trim()}
          onPress={() => void save()}
          style={styles.barButton}
        />
      </View>
      <View style={styles.who}>
        <Avatar id={text(profile.id)} size={48} />
      </View>
      <View style={styles.labelled}>
        <Txt v="meta" tone="secondary">
          Name
        </Txt>
        <TextInput value={name} onChangeText={setName} accessibilityLabel="Name" style={field} />
      </View>
      <View style={[styles.group, { backgroundColor: c["bg-raised"], borderColor: c.border }]}>
        <Pressable
          onPress={pickTool}
          accessibilityRole="button"
          accessibilityLabel={`Coding tool: ${definitionName(snapshot, definitionId)}`}
          style={[
            styles.line,
            { borderBottomColor: c.border, borderBottomWidth: StyleSheet.hairlineWidth },
          ]}
        >
          <Txt tone="muted" style={styles.flex}>
            Coding tool
          </Txt>
          <Txt>{definitionName(snapshot, definitionId)}</Txt>
          <Icon name="down" size={14} stroke={2} color={c["text-muted"]} />
        </Pressable>
        <View
          style={[
            styles.line,
            fastOffered && {
              borderBottomColor: c.border,
              borderBottomWidth: StyleSheet.hairlineWidth,
            },
          ]}
        >
          <Txt tone="muted" style={styles.flex}>
            Model
          </Txt>
          <TextInput
            value={model}
            onChangeText={setModel}
            placeholder="Tool default"
            placeholderTextColor={c["text-dim"]}
            accessibilityLabel="Model"
            style={[styles.inline, { color: c.text }]}
          />
        </View>
        {fastOffered ? (
          <View style={styles.fast}>
            <View style={styles.line}>
              <Txt tone="muted" style={styles.flex}>
                {t("agent.fastMode.label")}
              </Txt>
              <Switch
                value={fastMode}
                onValueChange={setFastMode}
                accessibilityLabel={t("agent.fastMode.label")}
                accessibilityHint={fastMode ? t("agent.fastMode.cost") : undefined}
              />
            </View>
            {fastMode ? (
              <Txt v="meta" tone="muted" style={styles.cost}>
                {t("agent.fastMode.cost")}
              </Txt>
            ) : null}
          </View>
        ) : null}
      </View>
      <View style={styles.labelled}>
        <Txt v="meta" tone="secondary">
          Instructions
        </Txt>
        <TextInput
          value={instructions}
          onChangeText={setInstructions}
          multiline
          accessibilityLabel="Instructions"
          style={[...field, styles.area]}
        />
      </View>
      <View style={styles.labelled}>
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Txt v="meta" tone="secondary">
            Talking style
          </Txt>
        </View>
        <Segmented
          label="Talking style"
          value={style}
          onChange={setStyle}
          options={[
            { value: "neutral", label: "Neutral" },
            { value: "warm", label: "Warm" },
            { value: "casual", label: "Casual" },
            { value: "direct", label: "Direct" },
          ]}
        />
      </View>
      <Txt v="meta" tone="muted">
        Sign in and API keys stay on your Mac. Changes apply to new conversations.
      </Txt>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  body: { padding: 20, paddingTop: 12, gap: 16 },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginHorizontal: -12,
  },
  barButton: { paddingHorizontal: 12 },
  who: { alignItems: "center" },
  labelled: { gap: 6 },
  input: {
    minHeight: touch,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    fontSize: 16,
  },
  area: { minHeight: 120, paddingTop: 12, textAlignVertical: "top", lineHeight: 22 },
  group: { borderRadius: 14, borderWidth: 1 },
  line: {
    minHeight: 52,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  flex: { flex: 1 },
  fast: { paddingBottom: 4 },
  cost: { paddingHorizontal: 16, paddingBottom: 10, marginTop: -6 },
  inline: { minWidth: 120, minHeight: touch, textAlign: "right", fontSize: 15 },
});

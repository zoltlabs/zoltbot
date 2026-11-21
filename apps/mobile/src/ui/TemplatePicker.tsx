// A1: pick an agent template on the New chat and Add employee screens. Picking one shows its
// role and instructions to adjust before the agent is created.
import { useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import type { TemplateRow } from "../data/agent-templates";
import { sans, touch, useTheme } from "../theme";
import { Icon } from "./icons";
import { Row, Txt } from "./kit";

export interface TemplateDraft {
  role: string;
  instructions: string;
}

export function TemplatePicker(props: {
  templates: TemplateRow[];
  picked: TemplateRow | undefined;
  draft: TemplateDraft;
  disabled: boolean;
  onPick: (template: TemplateRow | undefined) => void;
  onDraft: (draft: TemplateDraft) => void;
}) {
  const { c } = useTheme();
  const [open, setOpen] = useState(false);
  if (!props.templates.length) return null;
  const choose = (template: TemplateRow | undefined) => {
    setOpen(false);
    props.onPick(template);
  };
  const value = props.picked?.name ?? "Start blank";
  const field = [
    styles.input,
    { color: c.text, borderColor: c["border-strong"], backgroundColor: c["bg-raised"] },
  ];
  const check = <Icon name="check" size={18} stroke={2} color={c["accent-text"]} />;
  return (
    <>
      <View style={[styles.group, { backgroundColor: c["bg-raised"], borderColor: c.border }]}>
        <Pressable
          disabled={props.disabled}
          onPress={() => setOpen(!open)}
          accessibilityRole="button"
          accessibilityState={{ expanded: open, disabled: props.disabled }}
          accessibilityLabel={`Template: ${value}`}
          style={styles.line}
        >
          <Txt tone="muted" style={styles.key}>
            Template
          </Txt>
          <Txt style={styles.flex}>{value}</Txt>
          <View style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}>
            <Icon name="chevron" size={16} stroke={2} color={c["text-muted"]} />
          </View>
        </Pressable>
        {open ? (
          <View
            style={{
              backgroundColor: c["bg-sunken"],
              borderTopColor: c.border,
              borderTopWidth: StyleSheet.hairlineWidth,
            }}
          >
            <Row
              title="Start blank"
              right={props.picked ? undefined : check}
              onPress={() => choose(undefined)}
            />
            {props.templates.map((template, index) => (
              <Row
                key={template.id}
                title={template.name}
                label={`${template.name}, ${template.role}`}
                right={props.picked?.id === template.id ? check : undefined}
                last={index === props.templates.length - 1}
                onPress={() => choose(template)}
              />
            ))}
          </View>
        ) : null}
      </View>
      {props.picked ? (
        <>
          <View style={styles.labelled}>
            <Txt v="meta" tone="secondary">
              Role
            </Txt>
            <TextInput
              editable={!props.disabled}
              value={props.draft.role}
              onChangeText={(role) => props.onDraft({ ...props.draft, role })}
              maxLength={300}
              accessibilityLabel="Role"
              style={field}
            />
          </View>
          <View style={styles.labelled}>
            <Txt v="meta" tone="secondary">
              Instructions
            </Txt>
            <TextInput
              editable={!props.disabled}
              value={props.draft.instructions}
              onChangeText={(instructions) => props.onDraft({ ...props.draft, instructions })}
              maxLength={4000}
              multiline
              accessibilityLabel="Instructions"
              style={[...field, styles.area]}
            />
          </View>
        </>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  group: { borderRadius: 14, borderWidth: 1, overflow: "hidden" },
  line: {
    minHeight: 52,
    paddingHorizontal: 16,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  key: { width: 64 },
  flex: { flex: 1 },
  labelled: { gap: 6 },
  input: {
    fontFamily: sans,
    minHeight: touch,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    fontSize: 15,
  },
  area: { minHeight: 140, paddingTop: 12, textAlignVertical: "top", lineHeight: 22 },
});

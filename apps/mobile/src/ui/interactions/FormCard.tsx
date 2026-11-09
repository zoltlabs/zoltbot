import type { Interaction } from "@zoltbot/protocol";
import { useState } from "react";
import { StyleSheet, Switch, View } from "react-native";
import {
  type AnswerDraft,
  type FormField,
  fieldText,
  fieldValue,
  formAnswer,
  formDefaults,
  formFields,
  formSupported,
  formValid,
  readField,
  setField,
} from "../../data/interactions";
import { useTheme } from "../../theme";
import { Button, Segmented, Txt } from "../kit";
import { Field, OptionRow } from "./parts";

function Control({
  field,
  value,
  secret,
  disabled,
  onChange,
}: {
  field: FormField;
  value: unknown;
  secret: boolean;
  disabled: boolean;
  onChange: (value: unknown) => void;
}) {
  const { c } = useTheme();
  // Raw text keeps partial numbers ("1.", "-0") editable; only the parsed value is submitted.
  const [raw, setRaw] = useState<string | undefined>(undefined);
  const label = `${field.label}${field.required ? " (required)" : ""}`;
  if (field.type === "enum")
    return (
      <View style={styles.group} accessibilityRole="radiogroup" accessibilityLabel={label}>
        <Txt v="meta" tone="secondary">
          {label}
        </Txt>
        {field.options.length <= 3 && field.options.every((o) => String(o).length < 14) ? (
          <Segmented
            label={label}
            options={field.options.map((option, index) => ({
              value: String(index),
              label: String(option),
            }))}
            value={String(field.options.findIndex((option) => Object.is(option, value)))}
            onChange={(index) => onChange(field.options[Number(index)])}
            disabled={disabled}
          />
        ) : (
          field.options.map((option) => (
            <OptionRow
              key={`${typeof option}:${String(option)}`}
              label={String(option)}
              selected={Object.is(option, value)}
              disabled={disabled}
              onPress={() => onChange(option)}
            />
          ))
        )}
        {field.description ? (
          <Txt v="meta" tone="muted">
            {field.description}
          </Txt>
        ) : null}
      </View>
    );
  if (field.type === "boolean")
    return (
      <View style={styles.toggle}>
        <View style={styles.flex}>
          <Txt v="bodyMedium">{label}</Txt>
          {field.description ? (
            <Txt v="meta" tone="muted">
              {field.description}
            </Txt>
          ) : null}
        </View>
        <Switch
          value={value === true}
          onValueChange={onChange}
          disabled={disabled}
          trackColor={{ true: c.accent, false: c["bg-sunken"] }}
          accessibilityLabel={field.label}
        />
      </View>
    );
  return (
    <Field
      label={label}
      value={fieldText(field, raw, value)}
      onChange={(typed) => {
        setRaw(typed);
        onChange(fieldValue(field, typed));
      }}
      numeric={field.type === "number" || field.type === "integer"}
      secure={secret}
      disabled={disabled}
      {...(field.description ? { hint: field.description } : {})}
    />
  );
}

/** Flat schema forms (MCP elicitation). Unsupported schemas can only be declined or skipped. */
export function FormCard({
  request,
  disabled,
  submit,
}: {
  request: Interaction;
  disabled: boolean;
  submit: (draft: AnswerDraft) => Promise<boolean>;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(request.items.map((item) => [item.id, formDefaults(item)])),
  );
  const [touched, setTouched] = useState(false);
  const decline = () => void submit({ action: "decline" });
  if (!request.items.every(formSupported))
    return (
      <View style={styles.root}>
        <Txt tone="secondary">
          This form uses fields the phone cannot show. Decline it so your coding tool can continue,
          or answer it on your Mac.
        </Txt>
        <Button label="Decline" disabled={disabled} onPress={decline} />
      </View>
    );
  const valid = request.items.every((item) => formValid(item, values[item.id]));
  return (
    <View style={styles.root}>
      {request.items.map((item) => (
        <View key={item.id} style={styles.root}>
          <Txt v="bodyMedium">{item.prompt}</Txt>
          {formFields(item).map((field) => (
            <Control
              key={field.id}
              field={field}
              secret={item.secret === true}
              disabled={disabled}
              value={readField(item, values[item.id], field.id)}
              onChange={(next) => {
                setTouched(true);
                setValues((current) => ({
                  ...current,
                  [item.id]: setField(item, current[item.id], field.id, next),
                }));
              }}
            />
          ))}
        </View>
      ))}
      {touched && !valid ? (
        <Txt v="meta" tone="danger" accessibilityRole="text">
          Fill in the required fields with the values the form expects.
        </Txt>
      ) : null}
      <View style={styles.buttons}>
        <Button label="Decline" disabled={disabled} onPress={decline} />
        <Button
          label="Accept"
          kind="primary"
          disabled={disabled || !valid}
          onPress={() => void submit(formAnswer(request.items, values))}
          style={styles.flex}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 10 },
  flex: { flex: 1 },
  group: { gap: 6 },
  toggle: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 44 },
  buttons: { flexDirection: "row", gap: 8 },
});

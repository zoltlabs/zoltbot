import type { Interaction } from "@zoltbot/protocol";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import {
  type AnswerDraft,
  answered,
  answerSummary,
  chooseOption,
  type ItemAnswer,
  initialAnswers,
  otherAllowed,
  questionAnswer,
  typeOther,
} from "../../data/interactions";
import { Button, Txt } from "../kit";
import { Field, OptionRow } from "./parts";

/** One question per step, a review step when there are several, then Send. */
export function QuestionCard({
  request,
  disabled,
  submit,
}: {
  request: Interaction;
  disabled: boolean;
  submit: (draft: AnswerDraft) => Promise<boolean>;
}) {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, ItemAnswer>>(() =>
    initialAnswers(request.items),
  );
  const count = request.items.length;
  const item = request.items[step];
  const review = !item;
  const value = item ? (answers[item.id] ?? {}) : {};
  const update = (next: ItemAnswer) => {
    if (item) setAnswers((current) => ({ ...current, [item.id]: next }));
  };
  const valid = review || answered(value);
  const send = () => void submit(questionAnswer(request.items, answers));
  const next = () => {
    if (!valid || disabled) return;
    if (count > 1) setStep(step + 1);
    else send();
  };
  if (review)
    return (
      <View style={styles.root} accessibilityLabel="Review answers">
        <Txt v="section" accessibilityRole="header">
          Review answers
        </Txt>
        {request.items.map((entry, index) => (
          <View key={entry.id} style={styles.review}>
            <View style={styles.flex}>
              <Txt v="meta" tone="muted">
                {entry.header || `Question ${index + 1}`}
              </Txt>
              <Txt v="bodyMedium">{entry.prompt}</Txt>
              <Txt tone="secondary">{answerSummary(entry, answers[entry.id])}</Txt>
            </View>
            <Button
              kind="plain"
              label="Edit"
              a11y={`Edit answer ${index + 1}`}
              disabled={disabled}
              onPress={() => setStep(index)}
            />
          </View>
        ))}
        <View style={styles.buttons}>
          <Button label="Back" disabled={disabled} onPress={() => setStep(count - 1)} />
          <Button
            label="Send answers"
            kind="primary"
            disabled={disabled || !request.items.every((entry) => answered(answers[entry.id]))}
            onPress={send}
            style={styles.flex}
          />
        </View>
      </View>
    );
  const typed = item.secret ? String(value.value ?? "") : (value.other ?? "");
  return (
    <View style={styles.root}>
      {count > 1 ? (
        <Txt v="meta" tone="muted">
          {[item.header, `Question ${step + 1} of ${count}`].filter(Boolean).join(" · ")}
        </Txt>
      ) : item.header ? (
        <Txt v="meta" tone="muted">
          {item.header}
        </Txt>
      ) : null}
      <Txt v="bodyMedium" accessibilityRole="header">
        {item.prompt}
      </Txt>
      {item.multi ? (
        <Txt v="meta" tone="muted">
          Choose all that apply.
        </Txt>
      ) : null}
      <View accessibilityRole={item.multi ? undefined : "radiogroup"} style={styles.options}>
        {(item.options ?? []).map((option) => (
          <OptionRow
            key={option.id}
            label={option.label}
            description={option.description}
            recommended={option.recommended}
            multi={item.multi}
            selected={value.options?.includes(option.id) ?? false}
            disabled={disabled}
            onPress={() => update(chooseOption(item, value, option.id))}
          />
        ))}
      </View>
      {otherAllowed(item) ? (
        <Field
          label={item.secret ? "Private answer" : item.options?.length ? "Other" : "Your answer"}
          value={typed}
          onChange={(text) => update(typeOther(item, value, text))}
          placeholder={item.options?.length ? "Type your own answer" : "Type your answer"}
          secure={item.secret === true}
          multiline={!item.secret}
          disabled={disabled}
          {...(item.secret ? { hint: "Sent to your Mac only for this answer." } : {})}
        />
      ) : null}
      <View style={styles.buttons}>
        {step > 0 ? (
          <Button label="Back" disabled={disabled} onPress={() => setStep(step - 1)} />
        ) : null}
        <Button
          label={count === 1 ? "Send" : step === count - 1 ? "Review answers" : "Next"}
          kind="primary"
          disabled={disabled || !valid}
          onPress={next}
          style={styles.flex}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 10 },
  flex: { flex: 1 },
  options: { gap: 8 },
  review: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  buttons: { flexDirection: "row", gap: 8 },
});

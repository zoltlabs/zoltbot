import type { Interaction } from "@zoltbot/protocol";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { type AnswerDraft, approvalButtons, planAnswer } from "../../data/interactions";
import { Button } from "../kit";
import { Field } from "./parts";

/** Plan (and sign-off gate) review buttons. The plan itself is the card's markdown context. */
export function PlanCard({
  request,
  disabled,
  submit,
}: {
  request: Interaction;
  disabled: boolean;
  submit: (draft: AnswerDraft) => Promise<boolean>;
}) {
  const [feedback, setFeedback] = useState("");
  const gate = request.type === "gate";
  const { acceptEdits } = approvalButtons(request);
  const send = (kind: Parameters<typeof planAnswer>[0]) =>
    void submit(planAnswer(kind, request, feedback));
  return (
    <View style={styles.root}>
      <Field
        label="Feedback"
        value={feedback}
        onChange={setFeedback}
        placeholder="Comments or changes you want"
        multiline
        disabled={disabled}
      />
      <Button
        label={acceptEdits ? "Approve, review each edit" : "Approve"}
        kind="primary"
        disabled={disabled}
        onPress={() => send("approve")}
        a11y={gate ? "Approve" : "Approve the plan"}
      />
      {acceptEdits ? (
        <Button
          label="Approve and auto-accept edits"
          kind="secondary"
          disabled={disabled}
          onPress={() => send("approve_edits")}
          a11y="Approve the plan and auto-accept edits"
        />
      ) : null}
      <View style={styles.row}>
        <Button
          label={gate ? "Request changes" : "Keep planning"}
          disabled={disabled || !feedback.trim()}
          onPress={() => send("keep_planning")}
          style={styles.flex}
          a11y={gate ? "Request changes" : "Keep planning and send feedback"}
        />
        <Button
          label="Reject"
          disabled={disabled}
          onPress={() => send("reject")}
          style={styles.flex}
          a11y={gate ? "Reject" : "Reject the plan"}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 8 },
  flex: { flex: 1 },
  row: { flexDirection: "row", gap: 8 },
});

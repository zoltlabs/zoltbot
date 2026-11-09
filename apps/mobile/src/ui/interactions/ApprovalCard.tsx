import type { Interaction } from "@zoltbot/protocol";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { type AnswerDraft, approvalAnswer, approvalButtons } from "../../data/interactions";
import { Button, Txt } from "../kit";
import { Field } from "./parts";

/** Allow once, Allow for session (when offered), Deny, and Deny with a reason for the agent. */
export function ApprovalCard({
  request,
  disabled,
  submit,
}: {
  request: Interaction;
  disabled: boolean;
  submit: (draft: AnswerDraft) => Promise<boolean>;
}) {
  const [explaining, setExplaining] = useState(false);
  const [reason, setReason] = useState("");
  const buttons = approvalButtons(request);
  return (
    <View style={styles.root}>
      {request.items.map((item) =>
        item.prompt ? (
          <Txt key={item.id} tone="secondary">
            {item.prompt}
          </Txt>
        ) : null,
      )}
      {explaining ? (
        <>
          <Field
            label="Tell the agent why"
            value={reason}
            onChange={setReason}
            placeholder="What should it do instead?"
            multiline
            autoFocus
            disabled={disabled}
          />
          <View style={styles.row}>
            <Button label="Back" disabled={disabled} onPress={() => setExplaining(false)} />
            <Button
              label="Deny and send"
              kind="primary"
              disabled={disabled || !reason.trim()}
              onPress={() => void submit(approvalAnswer("deny", reason))}
              style={styles.flex}
            />
          </View>
        </>
      ) : (
        <>
          {buttons.allowOnce ? (
            <Button
              label="Allow once"
              kind="primary"
              disabled={disabled}
              onPress={() => void submit(approvalAnswer("allow_once"))}
            />
          ) : null}
          {buttons.allowSession ? (
            <Button
              label={buttons.sessionLabel}
              disabled={disabled}
              onPress={() => void submit(approvalAnswer("allow_session"))}
            />
          ) : null}
          <View style={styles.row}>
            <Button
              label="Deny"
              disabled={disabled}
              onPress={() => void submit(approvalAnswer("deny"))}
              style={styles.flex}
            />
            <Button
              label="Deny with reason"
              disabled={disabled}
              onPress={() => setExplaining(true)}
              style={styles.flex}
            />
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 8 },
  flex: { flex: 1 },
  row: { flexDirection: "row", gap: 8 },
});

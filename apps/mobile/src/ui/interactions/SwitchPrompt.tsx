import type { Interaction } from "@zoltbot/protocol";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { type SwitchQuestion, switchAnswer, switchDetail } from "../../data/backup-models";
import { useTheme } from "../../theme";
import { Button, Txt } from "../kit";
import { CheckRow } from "./controls";
import { useAnswer } from "./useAnswer";

/**
 * Asks once, above the composer, before a chat's work moves to another provider. Continue moves
 * it now; Wait keeps it until the limit resets.
 */
export function SwitchPrompt({
  request,
  question,
  who,
}: {
  request: Interaction;
  question: SwitchQuestion;
  who: string;
}) {
  const { c } = useTheme();
  const answer = useAnswer(request);
  const [remember, setRemember] = useState(false);
  const title = `Continue on ${question.provider}?`;
  const detail = switchDetail(question, who);
  const send = (go: boolean) => void answer.submit(switchAnswer(go, remember));
  return (
    <View
      accessibilityLabel={title}
      style={[styles.box, { backgroundColor: c["bg-sunken"], borderColor: c.border }]}
    >
      <View style={styles.text}>
        <Txt v="section" accessibilityRole="header">
          {title}
        </Txt>
        {detail ? (
          <Txt v="meta" tone="muted">
            {detail}
          </Txt>
        ) : null}
      </View>
      <CheckRow
        label={`Switch automatically in ${question.project || "this chat"}`}
        checked={remember}
        onChange={setRemember}
        disabled={answer.disabled}
      />
      {answer.error ? (
        <View accessibilityLiveRegion="polite">
          <Txt v="meta" tone="danger">
            {answer.error}
          </Txt>
        </View>
      ) : null}
      <View style={styles.buttons}>
        <Button
          label="Wait"
          a11y={question.until ? `Wait until ${question.until}` : "Wait for the limit to reset"}
          disabled={answer.disabled}
          onPress={() => send(false)}
        />
        <Button
          label={answer.busy ? "Sending…" : "Continue"}
          kind="primary"
          a11y={`Continue on ${question.provider}`}
          disabled={answer.disabled}
          onPress={() => send(true)}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, padding: 14, gap: 10 },
  text: { gap: 2 },
  buttons: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
});

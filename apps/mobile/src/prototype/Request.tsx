import type { Interaction } from "@zoltbot/protocol";
import { Alert, View } from "react-native";
import type { AnswerDraft } from "../data/interactions";
import { ApprovalCard } from "../ui/interactions/ApprovalCard";
import { PlanCard } from "../ui/interactions/PlanCard";
import { QuestionCard } from "../ui/interactions/QuestionCard";
import { Txt } from "../ui/kit";
import { widens } from "./model";

export function Request({
  request,
  answer,
}: {
  request: Interaction;
  answer: (draft: AnswerDraft) => void;
}) {
  const submit = async (draft: AnswerDraft) => {
    if (widens(draft.choice)) {
      Alert.alert(
        "Allow more than this action?",
        draft.choice === "allow_session"
          ? "The agent may run further commands in this session without asking again."
          : "The agent may apply further edits in this session without asking again.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Confirm", onPress: () => answer(draft) },
        ],
      );
    } else answer(draft);
    return true;
  };
  const props = { request, submit, disabled: false };
  return (
    <View style={{ gap: 12 }}>
      <Txt v="cardTitle" accessibilityRole="header">
        {request.title}
      </Txt>
      {request.context?.markdown ? <Txt>{request.context.markdown}</Txt> : null}
      {request.context?.command ? <Txt v="code">{request.context.command}</Txt> : null}
      {request.type === "approval" ? (
        <ApprovalCard {...props} />
      ) : request.type === "plan" ? (
        <PlanCard {...props} />
      ) : (
        <QuestionCard {...props} />
      )}
    </View>
  );
}

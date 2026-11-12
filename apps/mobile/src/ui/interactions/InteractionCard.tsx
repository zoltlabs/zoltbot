import type { Interaction } from "@zoltbot/protocol";
import { permissionExpansion } from "@zoltbot/ui/interactions/request-presentation";
import { Alert, StyleSheet, View } from "react-native";
import { type AnswerDraft, defaultTitles, typeLabels } from "../../data/interactions";
import { mono, useTheme } from "../../theme";
import { Avatar, Button, Card, Chip, Txt } from "../kit";
import { Markdown } from "../Markdown";
import { ApprovalCard } from "./ApprovalCard";
import { FormCard } from "./FormCard";
import { PlanCard } from "./PlanCard";
import { DiffBlock } from "./parts";
import { QuestionCard } from "./QuestionCard";
import { useAnswer } from "./useAnswer";

function Context({ request }: { request: Interaction }) {
  const { c } = useTheme();
  const context = request.context;
  if (!context) return null;
  const code = [styles.code, { backgroundColor: c["bg-sunken"], fontFamily: mono }];
  return (
    <View style={styles.context}>
      {context.markdown ? <Markdown value={context.markdown} /> : null}
      {context.command ? (
        <Txt v="code" style={code} accessibilityRole="text">
          {context.command}
        </Txt>
      ) : null}
      {context.cwd ? (
        <Txt v="meta" tone="muted">
          {`In ${context.cwd}`}
        </Txt>
      ) : null}
      {context.network ? (
        <Txt v="meta" tone="secondary">
          {`Network: ${context.network.host} · ${context.network.protocol}`}
        </Txt>
      ) : null}
      {context.paths?.length ? (
        <View style={styles.paths}>
          {context.paths.map((path) => (
            <Txt key={path} v="meta" tone="secondary" style={{ fontFamily: mono }}>
              {path}
            </Txt>
          ))}
        </View>
      ) : null}
      {context.diffs?.map((diff, index) => (
        <DiffBlock
          // A multi-edit request can carry several diffs for one path; the list never reorders.
          // biome-ignore lint/suspicious/noArrayIndexKey: index plus path is the stable identity
          key={`${index}:${diff.path}`}
          diff={diff}
          initiallyOpen={(context.diffs?.length ?? 0) === 1}
        />
      ))}
    </View>
  );
}

/**
 * A pending question, approval, plan, form or sign-off, answerable on the phone. It stays until
 * the interaction stops being pending, so a failed or stale answer keeps the card and the draft.
 */
export function InteractionCard({
  request,
  who,
  position,
}: {
  request: Interaction;
  who: string;
  /** "1 of 3" when the thread has more than one pending request. */
  position?: string;
}) {
  const answer = useAnswer(request);
  const { busy, error, disabled, online } = answer;
  const submit = async (draft: AnswerDraft): Promise<boolean> => {
    if (disabled) return false;
    const expansion = permissionExpansion(request, draft.choice);
    if (!expansion) return answer.submit(draft);
    Alert.alert(expansion.title, expansion.description, [
      { text: "Cancel", style: "cancel" },
      {
        text: expansion.action,
        onPress: () => {
          void answer.submit(draft);
        },
      },
    ]);
    return false;
  };
  const type = request.type;
  const body =
    type === "question" ? (
      <QuestionCard request={request} disabled={disabled} submit={submit} />
    ) : type === "approval" ? (
      <ApprovalCard request={request} disabled={disabled} submit={submit} />
    ) : type === "plan" || type === "gate" ? (
      <PlanCard request={request} disabled={disabled} submit={submit} />
    ) : (
      <FormCard request={request} disabled={disabled} submit={submit} />
    );
  return (
    <Card attention label={`${typeLabels[type]} from ${who}`}>
      <View style={styles.head}>
        <Avatar id={request.agentId} size={24} />
        <View style={styles.flex}>
          <Txt v="meta" tone="muted">
            {[who, position].filter(Boolean).join(" · ")}
          </Txt>
          <Txt v="cardTitle" accessibilityRole="header">
            {request.title || defaultTitles[type]}
          </Txt>
        </View>
        <Chip label={typeLabels[type]} tone="attention" dot />
      </View>
      <View accessibilityLiveRegion="polite">
        {error ? (
          <Txt v="meta" tone="danger" accessibilityRole="text">
            {error}
          </Txt>
        ) : null}
      </View>
      {!online ? (
        <Txt v="meta" tone="muted">
          Answering is paused until your Mac is reachable.
        </Txt>
      ) : null}
      <Context request={request} />
      {body}
      <View style={styles.footer}>
        {busy ? (
          <Txt v="meta" tone="muted" style={styles.flex}>
            Sending…
          </Txt>
        ) : (
          <View style={styles.flex} />
        )}
        <Button
          kind="plain"
          label={type === "form" ? "Cancel" : "Skip"}
          a11y={
            type === "form" ? "Cancel this form" : `Skip this ${typeLabels[type].toLowerCase()}`
          }
          disabled={disabled}
          onPress={() => void submit({ action: "cancel" })}
        />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  head: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  context: { gap: 8 },
  code: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, overflow: "hidden" },
  paths: { gap: 2 },
  footer: { flexDirection: "row", alignItems: "center", gap: 8 },
});

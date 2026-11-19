import type { Interaction } from "@zoltbot/protocol";
import { router } from "expo-router";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import {
  allowanceChange,
  approveLabel,
  askTitle,
  cardFields,
  type StaffCardData,
  type StaffField,
  staffAnswer,
  toStaffCard,
} from "../../data/staff";
import type { Row } from "../../data/transport";
import { useAction } from "../../state/actions";
import { mono, useTheme } from "../../theme";
import { Avatar, Button, Card, Chip, Txt } from "../kit";
import { CheckRow, Stepper } from "./controls";
import { useAnswer } from "./useAnswer";

const STAFF_MAX = 20;

function Field({ row, first }: { row: StaffField; first: boolean }) {
  const { c } = useTheme();
  const stacked = row.label === "First task" || (row.before && row.after);
  const code = row.label === "Can edit" ? { fontFamily: mono } : undefined;
  const said =
    row.before && row.after
      ? `${row.label}: was ${row.before}, now ${row.after}`
      : `${row.label}: ${row.after ?? row.before ?? ""}`;
  return (
    <View
      accessible
      accessibilityLabel={said}
      style={[
        stacked ? styles.stacked : styles.pair,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
      ]}
    >
      <Txt tone="muted" style={stacked ? undefined : styles.key}>
        {row.label}
      </Txt>
      {row.before && row.after ? (
        <View style={styles.diff}>
          <Txt tone="muted" style={[styles.was, code]}>
            {row.before}
          </Txt>
          <Txt style={code}>{`→ ${row.after}`}</Txt>
        </View>
      ) : (
        <Txt style={[stacked ? undefined : styles.value, code]}>
          {row.after ?? row.before ?? ""}
        </Txt>
      )}
    </View>
  );
}

/**
 * The approval for adding, changing or archiving an employee, inline in the manager's chat and
 * in the Inbox. Approving can also let the manager add more like it without asking.
 */
export function StaffCard({
  request,
  showChat,
}: {
  request: Row;
  /** Outside the asking chat: a button that opens it. */
  showChat?: boolean;
}) {
  const card = toStaffCard(request);
  if (!card) return null;
  return <StaffCardBody card={card} request={request} showChat={showChat} />;
}

function StaffCardBody({
  card,
  request,
  showChat,
}: {
  card: StaffCardData;
  request: Row;
  showChat?: boolean | undefined;
}) {
  const { c } = useTheme();
  const answer = useAnswer(request as unknown as Interaction);
  const { run } = useAction();
  const [grant, setGrant] = useState(false);
  const [max, setMax] = useState(card.allowance?.max ?? 1);
  const pending = card.state === "pending";
  const manager = card.requestedBy || "this manager";
  const fields = cardFields(card);
  const decide = async (approve: boolean) => {
    const sent = await answer.submit(staffAnswer(approve, approve && grant));
    const change = sent && approve ? allowanceChange(card, grant, max) : undefined;
    if (change) await run("staff.allowance", change, { key: `allowance:${card.requestId}` });
  };
  return (
    <Card attention={pending} label={askTitle(card)}>
      <View style={styles.head}>
        <Avatar id={card.name || card.requestId} size={36} />
        <View style={styles.flex}>
          <Txt v="cardTitle" accessibilityRole="header">
            {pending ? askTitle(card) : card.title}
          </Txt>
          {card.requestedBy ? (
            <Txt v="meta" tone="muted">
              {`From ${card.requestedBy}`}
            </Txt>
          ) : null}
        </View>
        {pending ? null : (
          <Chip
            label={card.state === "approved" ? "Approved" : "Declined"}
            tone={card.state === "approved" ? "ok" : "neutral"}
          />
        )}
      </View>
      {fields.length || card.moves.length ? (
        <View style={[styles.group, { backgroundColor: c["bg-sunken"], borderColor: c.border }]}>
          {fields.map((row, index) => (
            <Field key={row.label} row={row} first={index === 0} />
          ))}
          {card.moves.map((move, index) => (
            <Field
              key={`move:${move.title}`}
              row={{ label: "Queued task", after: `${move.title} → ${move.to}` }}
              first={!fields.length && index === 0}
            />
          ))}
        </View>
      ) : null}
      {card.action === "archive" ? (
        <Txt v="meta" tone="muted">
          {`${card.running ? "Running work finishes first. " : ""}${card.name}’s chat stays readable.`}
        </Txt>
      ) : null}
      {card.sharedWith ? (
        <Txt v="meta" tone="muted">
          {`Also changes ${card.sharedWith} other ${card.sharedWith === 1 ? "chat" : "chats"} with the same profile.`}
        </Txt>
      ) : null}
      {pending && card.allowance ? (
        <View style={[styles.group, styles.allow, { borderColor: c.border }]}>
          <CheckRow
            label={`Let ${manager} add more without asking`}
            note="Same models and folders"
            checked={grant}
            onChange={setGrant}
            disabled={answer.disabled}
          />
          <View style={styles.upTo}>
            <Txt tone="muted" style={styles.flex}>
              Up to
            </Txt>
            <Stepper
              label={`How many more ${manager} can add`}
              value={max}
              min={1}
              max={STAFF_MAX}
              onChange={setMax}
              disabled={answer.disabled || !grant}
            />
          </View>
        </View>
      ) : null}
      <View accessibilityLiveRegion="polite">
        {answer.error ? (
          <Txt v="meta" tone="danger">
            {answer.error}
          </Txt>
        ) : null}
      </View>
      {pending ? (
        <View style={styles.buttons}>
          <Button
            label="Decline"
            a11y={`Decline: ${card.title}`}
            disabled={answer.disabled}
            onPress={() => void decide(false)}
            style={styles.flex}
          />
          <Button
            label={answer.busy ? "Sending…" : approveLabel(card)}
            kind="primary"
            disabled={answer.disabled}
            onPress={() => void decide(true)}
            style={styles.flex}
          />
        </View>
      ) : null}
      {showChat && card.threadId ? (
        <Button
          kind="plain"
          label={`Open ${card.requestedBy || "chat"}`}
          onPress={() => router.push(`/chat/${card.threadId}`)}
        />
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  head: { flexDirection: "row", alignItems: "center", gap: 12 },
  group: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  allow: { paddingHorizontal: 14, paddingVertical: 12, gap: 6 },
  pair: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 16,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  stacked: { gap: 4, paddingHorizontal: 14, paddingVertical: 11 },
  key: { flexShrink: 0 },
  value: { flexShrink: 1, textAlign: "right" },
  diff: { gap: 2 },
  was: { textDecorationLine: "line-through" },
  upTo: { flexDirection: "row", alignItems: "center", gap: 10, paddingLeft: 34 },
  buttons: { flexDirection: "row", gap: 10 },
});

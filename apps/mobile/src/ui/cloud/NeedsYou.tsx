import type { Interaction } from "@zoltbot/protocol";
import { router } from "expo-router";
import { useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { cloudRequests, macRequestDetails } from "../../cloud/needs-you";
import type { CloudSessionState } from "../../cloud/session";
import type { AnswerDraft } from "../../data/interactions";
import { OutcomeUnknownError } from "../../data/transport";
import { cloudSession, useCloud } from "../../state/cloud";
import { mono, useTheme } from "../../theme";
import { RequestCard } from "../interactions/InteractionCard";
import { Button, Card, Section, showConfirmSheet, Txt } from "../kit";

type Owner = NonNullable<CloudSessionState["owner"]>;

export function useCloudPendingCount() {
  const snapshot = useCloud((state) => state.cell?.snapshot);
  return useMemo(() => (snapshot ? cloudRequests(snapshot).length : 0), [snapshot]);
}

export function CloudNeedsYou({
  orgId,
  threadId,
  standalone = false,
}: {
  orgId?: string;
  threadId?: string;
  standalone?: boolean;
}) {
  const { checked, account, owner, cell, error } = useCloud((state) => state);
  if (!standalone && !account.configured) return null;

  const changedOrg = orgId !== undefined && orgId !== owner?.orgId;
  const waiting =
    !checked ||
    (account.signedIn && account.online && !error && !cell) ||
    cell?.status === "connecting";
  const snapshot = changedOrg ? undefined : cell?.snapshot;
  const requests = snapshot ? cloudRequests(snapshot, threadId) : [];
  const offline = cell?.readOnly !== false;
  let notice = "";
  if (!account.configured) notice = "Cloud is unavailable in this build.";
  else if (waiting && !requests.length) notice = "Connecting to Cloud…";
  else if (error === "cloud_account") notice = "Couldn’t check your account. Try again.";
  else if (changedOrg) notice = "This Cloud request is unavailable for your account.";
  else if (error === "cloud_access" || cell?.error === "cloud_authority_refused")
    notice = "Cloud access is unavailable for this account.";
  else if (account.signedIn && offline) notice = "Cloud is offline. Reconnect to answer requests.";
  else if (account.signedIn && !requests.length)
    notice = threadId ? "No open requests in this conversation." : "Nothing needs you in Cloud.";

  return (
    <View style={styles.section}>
      {standalone ? null : <Section title="Cloud" count={requests.length || undefined} />}
      <View accessibilityLiveRegion="polite">
        {notice ? <Txt tone="muted">{notice}</Txt> : null}
      </View>
      {account.configured && checked && !account.signedIn && !changedOrg && !error ? (
        <Button label="Sign in to Cloud" onPress={() => router.push("/cloud-account")} />
      ) : null}
      {error || (account.signedIn && !waiting && offline && !changedOrg) ? (
        <Button label="Try again" onPress={() => void cloudSession.retry()} />
      ) : null}
      {changedOrg && !waiting ? (
        <Button label="Open Cloud Needs you" onPress={() => router.replace("/cloud-needs-you")} />
      ) : null}
      {owner && snapshot
        ? requests.map((request) => {
            const task = snapshot.entities.task?.find((item) => item.id === request.taskId);
            const agent = snapshot.entities.agent?.find((item) => item.id === request.agentId);
            return (
              <CloudCard
                key={`${owner.sessionId}:${request.id}:${request.version}`}
                owner={owner}
                request={request}
                who={typeof agent?.name === "string" && agent.name ? agent.name : request.agentId}
                task={typeof task?.title === "string" ? task.title : request.taskId}
                offline={offline}
              />
            );
          })
        : null}
    </View>
  );
}

function CloudCard({
  owner,
  request,
  who,
  task,
  offline,
}: {
  owner: Owner;
  request: Interaction;
  who: string;
  task: string | undefined;
  offline: boolean;
}) {
  const { c } = useTheme();
  const flight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const disabled = offline || busy || submitted;
  const submit = async (draft: AnswerDraft) => {
    if (flight.current || disabled) return false;
    flight.current = true;
    setBusy(true);
    setError("");
    try {
      await cloudSession.answer(owner, request, draft);
      setSubmitted(true);
      return true;
    } catch (reason) {
      if (reason instanceof OutcomeUnknownError) {
        setSubmitted(true);
        setError("Couldn’t confirm your answer. Check this request after Cloud reconnects.");
      } else {
        const code = reason instanceof Error ? reason.message : "";
        setError(
          code === "cloud_offline"
            ? "Reconnect to Cloud, then try again."
            : code === "cloud_answer_pending"
              ? "An answer is already pending. Check this request after Cloud reconnects."
              : "Couldn’t send your answer. Check whether the request changed, then try again.",
        );
      }
      return false;
    } finally {
      flight.current = false;
      setBusy(false);
    }
  };

  if (!request.context?.macExec)
    return (
      <RequestCard
        request={request}
        who={who}
        answer={{ busy, disabled, error, online: !offline, submit }}
      />
    );

  const details = macRequestDetails(request);
  const detail =
    details?.draft.orgId === owner.orgId && details.draft.userId === owner.userId
      ? details
      : undefined;
  const codeStyle = [styles.code, { backgroundColor: c["bg-sunken"], fontFamily: mono }];
  const target = detail?.mac;
  const prefix = detail?.prefix;
  return (
    <Card attention>
      <Txt v="cardTitle" accessibilityRole="header">
        Run on my Mac
      </Txt>
      {detail ? (
        <>
          <Txt tone="secondary">{target}</Txt>
          <Txt tone="secondary">{[task, who].filter(Boolean).join(" · ")}</Txt>
          <Txt v="code" style={codeStyle} selectable>
            {detail.draft.command}
          </Txt>
          <View style={styles.field}>
            <Txt v="meta" tone="muted">
              Folder
            </Txt>
            <Txt tone="secondary" selectable>
              {detail.draft.cwd}
            </Txt>
          </View>
          {detail.stdin ? (
            <>
              <Txt tone="secondary">Standard input</Txt>
              <Txt v="code" style={codeStyle} selectable>
                {detail.stdin}
              </Txt>
            </>
          ) : null}
          <View style={styles.field}>
            <Txt v="meta" tone="muted">
              Timeout
            </Txt>
            <Txt tone="secondary">{`${detail.draft.timeoutSeconds} seconds`}</Txt>
          </View>
          <Txt tone="secondary">
            The command’s output goes to this Cloud task and its model provider.
          </Txt>
          {detail.canRun ? (
            <Button
              kind="primary"
              label="Run"
              disabled={disabled}
              onPress={() => void submit({ action: "accept", choice: "allow_once" })}
            />
          ) : null}
          {prefix ? (
            <Button
              label="Allow commands like this for this task"
              disabled={disabled}
              onPress={() =>
                showConfirmSheet({
                  title: "Allow commands like this?",
                  body: `Commands that start with “${prefix}” can run on this Mac during this task.`,
                  confirmLabel: "Allow for this task",
                  onConfirm: () => void submit({ action: "accept", choice: "allow_task_prefix" }),
                })
              }
            />
          ) : null}
        </>
      ) : (
        <View accessibilityRole="alert">
          <Txt tone="danger">Couldn’t verify the command. Ask the agent to send it again.</Txt>
        </View>
      )}
      <Button
        label="Deny"
        disabled={disabled}
        onPress={() => void submit({ action: "decline", choice: "reject_once" })}
      />
      <View accessibilityLiveRegion="polite">
        {error || busy ? <Txt tone={error ? "danger" : "muted"}>{error || "Sending…"}</Txt> : null}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  section: { gap: 8 },
  field: { gap: 2 },
  code: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10 },
});

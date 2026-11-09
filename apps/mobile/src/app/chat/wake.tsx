import { parse, type Wake, WakeSchema } from "@zoltbot/protocol";
import { router, useLocalSearchParams } from "expo-router";
import { useRef, useState } from "react";
import { View } from "react-native";
import { text } from "../../data/view";
import {
  localWakeTime,
  type WakeForm,
  wakeInput,
  wakeKinds,
  wakeSelection,
  wakeSources,
} from "../../data/wakes";
import { useAction } from "../../state/actions";
import { useClient, useSnapshot } from "../../state/link";
import { Choice, DetailScreen, Field } from "../../ui/DetailScreen";
import { Button, Card, Txt } from "../../ui/kit";

export default function WakeEditorRoute() {
  const { id, wakeId } = useLocalSearchParams<{ id: string; wakeId?: string }>();
  const snapshot = useSnapshot();
  const row = snapshot.entities.wake?.find((w) => w.id === wakeId && w.threadId === id);
  if (!snapshot.entities.thread?.some((t) => t.id === id) || (wakeId && !row))
    return (
      <DetailScreen title="Wake when…">
        <Txt>This chat or wait is unavailable. Return to the chat and try again.</Txt>
      </DetailScreen>
    );
  return (
    <WakeEditor
      key={wakeId ?? id}
      threadId={id}
      existing={row ? parse(WakeSchema, row) : undefined}
    />
  );
}
function WakeEditor({ threadId, existing }: { threadId: string; existing: Wake | undefined }) {
  const snapshot = useSnapshot();
  const online = useClient((s) => s.status === "online");
  const { run, busy } = useAction();
  // Preserve the revision the person reviewed; a concurrent edit requires reopening this form.
  const original = useRef(existing).current;
  const c = original?.condition;
  const [form, setForm] = useState<WakeForm>({
    kind: c?.kind ?? "job",
    selected: wakeSelection(original),
    repository: c?.kind === "pr" || c?.kind === "ci" ? c.repository : "",
    number: c?.kind === "pr" ? String(c.number) : c?.kind === "ci" ? c.runId : "",
    attempt: c?.kind === "ci" ? String(c.attempt) : "1",
    phrase: c?.kind === "topic" ? c.phrase : "",
    outcome: c && "outcome" in c ? c.outcome : "finished",
    behavior: original?.behavior ?? "inbox",
    continuation: original?.continuation ?? "",
    fallback: localWakeTime(original?.fallbackAt ?? new Date(Date.now() + 86400000).toISOString()),
  });
  const [error, setError] = useState("");
  const update = <K extends keyof WakeForm>(key: K, value: WakeForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const projectId = text(snapshot.entities.thread?.find((t) => t.id === threadId)?.projectId);
  const current = snapshot.entities.wake?.find((w) => w.id === original?.id);
  const stale =
    !!original &&
    (current?.revision !== original.revision ||
      !!current?.itemId ||
      !["draft", "waiting", "ready", "needs_attention"].includes(text(current?.status)));
  const save = async () => {
    setError("");
    try {
      const input = wakeInput(threadId, projectId, form);
      if (
        ["job", "task", "turn"].includes(form.kind) &&
        !wakeSources(snapshot, threadId, form.kind).some((s) => s.value === form.selected)
      )
        throw Error("This source is no longer available. Choose a tracked source.");
      const result = await run(
        "wake.save",
        { input, ...(original ? { id: original.id, revision: original.revision } : {}) },
        { quiet: true },
      );
      if (result) router.back();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "";
      setError(
        message.includes("already_waiting")
          ? "This chat already has a wait. Edit or cancel it first."
          : message.includes("cycle") || message.includes("self_dependency")
            ? "These chats would wait on each other. Choose another source."
            : message.includes("future_fallback")
              ? "Choose a fallback time in the future."
              : message.includes(" ") && !message.includes("wake_")
                ? message
                : "Could not save the wait. Check the source, GitHub sign-in on your Mac, and fallback time. Reopen this form if the wait changed.",
      );
    }
  };
  const field = (
    key: "repository" | "number" | "attempt" | "phrase" | "continuation" | "fallback",
    label: string,
    extra = {},
  ) => (
    <Field
      label={label}
      value={form[key]}
      onChange={(value) => update(key, value)}
      disabled={busy}
      {...extra}
    />
  );
  return (
    <DetailScreen
      title={
        original?.status === "draft"
          ? "Review proposed wait"
          : original
            ? "Edit wait"
            : "Wake when…"
      }
    >
      <Txt>
        Put this chat aside until a specific condition happens. The fallback brings it back if the
        condition cannot be confirmed.
      </Txt>
      <Choice
        label="Condition"
        value={form.kind}
        options={wakeKinds.filter((k) => projectId || k.value !== "topic")}
        disabled={busy}
        onChange={(kind) => setForm((f) => ({ ...f, kind, selected: "" }))}
      />
      {["job", "task", "turn"].includes(form.kind) ? (
        <Choice
          label="Tracked source"
          value={form.selected}
          options={wakeSources(snapshot, threadId, form.kind)}
          onChange={(v) => update("selected", v)}
          disabled={busy}
        />
      ) : null}
      {form.kind === "pr" || form.kind === "ci" ? (
        <>
          {field("repository", "GitHub repository", {
            hint: "owner/repository. Uses GitHub CLI sign-in on your Mac.",
          })}
          {field("number", form.kind === "pr" ? "Pull request number" : "Workflow run ID", {
            numeric: true,
          })}
          {form.kind === "ci" ? field("attempt", "Run attempt", { numeric: true }) : null}
        </>
      ) : null}
      {form.kind === "topic"
        ? field("phrase", "Phrase to watch for", {
            maxLength: 200,
            hint: "Matches your new messages in other chats in this workspace, ignoring case. Agent messages do not match.",
          })
        : null}
      {form.kind !== "topic" && form.kind !== "pr" ? (
        <Choice
          label="Wake after"
          value={form.outcome}
          options={[
            { value: "finished", label: "Any result, including failure or cancellation" },
            { value: "passed", label: "Successful completion only" },
          ]}
          onChange={(v) => update("outcome", v)}
          disabled={busy}
        />
      ) : null}
      {form.kind !== "topic" ? (
        <Choice
          label="Then"
          value={form.behavior}
          options={[
            { value: "inbox", label: "Bring back to inbox" },
            { value: "resume", label: "Resume automatically in this chat" },
          ]}
          onChange={(v) => update("behavior", v)}
          disabled={busy}
        />
      ) : (
        <Txt>Then: bring this chat back to the inbox.</Txt>
      )}
      {form.behavior === "resume" && form.kind !== "topic"
        ? field("continuation", "Next step", {
            multiline: true,
            maxLength: 2400,
            hint: "Uses this chat’s existing permissions. Pending approvals still need your answer.",
          })
        : null}
      <View style={{ gap: 8 }}>
        <Txt v="bodyMedium">Quick fallback</Txt>
        <Button
          label="In 1 hour"
          disabled={busy}
          onPress={() =>
            update("fallback", localWakeTime(new Date(Date.now() + 3600000).toISOString()))
          }
        />
        <Button
          label="In 24 hours"
          disabled={busy}
          onPress={() =>
            update("fallback", localWakeTime(new Date(Date.now() + 86400000).toISOString()))
          }
        />
      </View>
      {field("fallback", "Fallback time (local timezone)", {
        hint: "Use YYYY-MM-DDTHH:mm, for example 2026-12-01T09:30. Returns to the inbox without running the next step if unconfirmed.",
      })}
      <Card>
        <Txt>Monitoring runs on your Mac while Zoltbot is awake. Checks pause while it sleeps.</Txt>
      </Card>
      <View accessibilityLiveRegion="polite" accessibilityRole="alert">
        {error || stale ? (
          <Txt>
            {stale ? "This wait changed. Return to the chat and reopen it before saving." : error}
          </Txt>
        ) : null}
      </View>
      <Button
        label={busy ? "Saving wait…" : "Save wait"}
        kind="primary"
        disabled={busy || !online || stale}
        onPress={() => void save()}
      />
      <Button label="Cancel" onPress={() => router.back()} disabled={busy} />
    </DetailScreen>
  );
}

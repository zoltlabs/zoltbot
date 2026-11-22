import { proseDiff } from "@zoltbot/ui/documents/prose-diff";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { text } from "../../data/view";
import { useAction } from "../../state/actions";
import { useClient, useLink, useSnapshot } from "../../state/link";
import { useTheme } from "../../theme";
import { BackBar, OfflineBanner } from "../../ui/chrome";
import { Button, showPrompt, Txt } from "../../ui/kit";

interface DocumentChanges {
  path: string;
  before: string;
  after: string | null;
}

/**
 * A document task's changes, word by word, as the Mac's review shows them. Accept keeps them;
 * Send back asks the agent for another pass. Comments are written on the Mac.
 */
export default function DocumentReview() {
  const { taskId } = useLocalSearchParams<{ taskId: string }>();
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const snapshot = useSnapshot();
  const online = useClient((state) => state.status === "online");
  const { run, busy } = useAction();
  const task = snapshot.entities.task?.find((row) => row.id === taskId);
  const owner = snapshot.entities.agent?.find((row) => row.id === task?.ownerAgentId);
  const revision = Number(task?.revision) || 1;
  const [changes, setChanges] = useState<DocumentChanges>();
  const [error, setError] = useState("");

  // A new revision or a finished turn changes the file, so read it again.
  const updatedAt = text(task?.updatedAt);
  useEffect(() => {
    const client = useLink.getState().client?.getState();
    if (!client || !online || !taskId || !updatedAt) return;
    let live = true;
    client
      .call("document.changes", { id: taskId })
      .then((value) => {
        if (live) {
          setChanges(value as DocumentChanges);
          setError("");
        }
      })
      .catch(() => {
        if (live) setError("Couldn't load the changes. Your Mac may be asleep.");
      });
    return () => {
      live = false;
    };
  }, [taskId, online, updatedAt]);

  const review = async (decision: "accept" | "changes", feedback?: string) => {
    const done = await run("task.review", {
      id: taskId,
      revision,
      decision,
      ...(feedback ? { feedback } : {}),
      confirmed: true,
    });
    if (done) router.back();
  };
  const sendBack = () =>
    showPrompt({
      title: "Send back",
      message: "What should change?",
      confirmLabel: "Send back",
      optional: true,
      onSubmit: (value) => void review("changes", value || undefined),
    });

  const diff = changes && changes.after !== null ? proseDiff(changes.before, changes.after) : null;
  const name =
    (changes?.path ?? text((task?.document as { path?: unknown } | undefined)?.path))
      .split("/")
      .pop() || "Document";
  const count = diff?.changes.length ?? 0;
  const by = text(owner?.name);
  return (
    <View style={[styles.page, { backgroundColor: c["bg-page"], paddingTop: insets.top + 4 }]}>
      <BackBar label="Tasks" />
      <ScrollView contentContainerStyle={styles.body}>
        <Txt v="largeTitle" accessibilityRole="header" lines={2}>
          {name}
        </Txt>
        <OfflineBanner />
        {diff ? (
          <Txt v="meta" tone="muted">
            {[by ? `Changes by ${by}` : "", `${count} ${count === 1 ? "change" : "changes"}`]
              .filter(Boolean)
              .join(" · ")}
          </Txt>
        ) : null}
        {error ? <Txt tone="muted">{error}</Txt> : null}
        {changes && changes.after === null ? (
          <Txt tone="muted">This file isn't in the project folder anymore.</Txt>
        ) : null}
        {diff ? (
          <Text style={[styles.doc, { color: c.text }]} selectable>
            {diff.segments.map((segment, index) =>
              segment.type === "equal" ? (
                segment.text
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: segments keep their order
                <Text key={index}>
                  {segment.change.removed ? (
                    <Text
                      style={[
                        styles.removed,
                        { color: c.danger, backgroundColor: c["danger-soft"] },
                      ]}
                    >
                      {segment.change.removed}
                    </Text>
                  ) : null}
                  {segment.change.added ? (
                    <Text style={[styles.added, { color: c.ok, backgroundColor: c["ok-soft"] }]}>
                      {segment.change.added}
                    </Text>
                  ) : null}
                </Text>
              ),
            )}
          </Text>
        ) : null}
      </ScrollView>
      {task?.state === "review" ? (
        <View
          style={[
            styles.actions,
            {
              borderTopColor: c.border,
              backgroundColor: c["bg-page"],
              paddingBottom: insets.bottom + 8,
            },
          ]}
        >
          <View style={styles.flex}>
            <Button label="Send back" disabled={!online || busy} onPress={sendBack} />
          </View>
          <View style={styles.flex}>
            <Button
              label="Accept"
              kind="primary"
              disabled={!online || busy}
              onPress={() => void review("accept")}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  body: { padding: 16, gap: 12 },
  doc: { fontSize: 17, lineHeight: 27 },
  removed: { textDecorationLine: "line-through" },
  added: { textDecorationLine: "underline" },
  actions: {
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  flex: { flex: 1 },
});

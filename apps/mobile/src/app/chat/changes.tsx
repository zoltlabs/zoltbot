import { useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { threadChanges } from "../../data/changes";
import { threadSession } from "../../data/session";
import { ago, text } from "../../data/view";
import { useAction } from "../../state/actions";
import { useClient, useLink, useSnapshot } from "../../state/link";
import { mono, useTheme } from "../../theme";
import { BackBar, OfflineBanner } from "../../ui/chrome";
import { Button, Card, Chip, Txt } from "../../ui/kit";

/** Whether the Mac can put files back to before a turn, from a dry run; unknown until it answers. */
type Restore = { files: string[] } | "read_only" | undefined;

/**
 * What this chat changed, turn by turn. A turn is labelled Revertible only when the agent's own
 * rewind says it can restore files to before it (D-5); everything else is Read only.
 */
export default function Changes() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const snapshot = useSnapshot();
  const online = useClient((state) => state.status === "online");
  const { run, busy } = useAction();
  const turns = threadChanges(snapshot, id);
  const sessionId = text(threadSession(snapshot, id)?.id);
  const [restore, setRestore] = useState<Record<string, Restore>>({});
  const key = turns.map((turn) => turn.turnId).join(",");

  useEffect(() => {
    const client = useLink.getState().client?.getState();
    if (!client || !online || !key) return;
    let live = true;
    for (const turnId of key.split(","))
      void (
        sessionId
          ? client.call("session.rewind", { id: sessionId, turnId, dryRun: true, confirmed: false })
          : Promise.reject(new Error("no_session"))
      )
        .then((value) => {
          const row = (value ?? {}) as { canRewind?: boolean; files?: unknown; error?: unknown };
          const files = Array.isArray(row.files)
            ? row.files.filter((file): file is string => typeof file === "string")
            : [];
          return row.canRewind === true && !row.error && files.length
            ? { files }
            : ("read_only" as const);
        })
        .catch(() => "read_only" as const)
        .then((value) => {
          if (live) setRestore((now) => ({ ...now, [turnId]: value }));
        });
    return () => {
      live = false;
    };
  }, [key, sessionId, online]);

  const revert = (turnId: string, files: string[]) =>
    Alert.alert(
      "Restore files to before this?",
      `${files.length} ${files.length === 1 ? "file goes" : "files go"} back, including later edits to ${files.length === 1 ? "it" : "them"}. The chat itself stays.`,
      [
        { text: "Keep", style: "cancel" },
        {
          text: "Restore",
          style: "destructive",
          onPress: () =>
            void run("session.rewind", { id: sessionId, turnId, dryRun: false, confirmed: true }),
        },
      ],
    );

  return (
    <View style={[styles.page, { backgroundColor: c["bg-page"], paddingTop: insets.top + 4 }]}>
      <BackBar label="the chat" />
      <ScrollView contentContainerStyle={styles.body}>
        <Txt v="largeTitle" accessibilityRole="header">
          Changes
        </Txt>
        <OfflineBanner />
        {turns.length === 0 ? <Txt tone="muted">No file changes in this chat.</Txt> : null}
        {turns.map((turn) => {
          const state = restore[turn.turnId];
          return (
            <Card key={turn.turnId} label={turn.prompt || "Changes"}>
              <View style={styles.head}>
                <View style={styles.flex}>
                  <Txt v="cardTitle" lines={2}>
                    {turn.prompt || "Changes"}
                  </Txt>
                  <Txt v="meta" tone="muted">
                    {`${turn.files.length} ${turn.files.length === 1 ? "file" : "files"} · ${ago(turn.at)}`}
                  </Txt>
                </View>
                {state === undefined ? null : state === "read_only" ? (
                  <Chip label="Read only" />
                ) : (
                  <Chip label="Revertible" tone="ok" />
                )}
              </View>
              {turn.files.map((file) => (
                <View
                  key={file.path}
                  style={styles.file}
                  accessible
                  accessibilityLabel={`${file.path}, ${file.added} added, ${file.removed} removed`}
                >
                  <Txt
                    v="meta"
                    tone="secondary"
                    lines={1}
                    style={[styles.flex, { fontFamily: mono }]}
                  >
                    {file.path}
                  </Txt>
                  <Txt v="meta" style={{ fontFamily: mono, color: c.ok }}>{`+${file.added}`}</Txt>
                  <Txt v="meta" style={{ fontFamily: mono, color: c.danger }}>
                    {`−${file.removed}`}
                  </Txt>
                </View>
              ))}
              {state && state !== "read_only" ? (
                <Button
                  label="Restore to before this"
                  disabled={!online || busy}
                  onPress={() => revert(turn.turnId, state.files)}
                />
              ) : null}
            </Card>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  body: { padding: 16, gap: 12 },
  head: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  flex: { flex: 1 },
  file: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 28 },
});

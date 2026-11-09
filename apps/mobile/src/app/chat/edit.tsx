import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, TextInput, View } from "react-native";
import { threadSession } from "../../data/session";
import { text, transcript } from "../../data/view";
import { newId } from "../../state/actions";
import { useClient, useLink, useSnapshot } from "../../state/link";
import { sans, useTheme } from "../../theme";
import { OfflineBanner } from "../../ui/chrome";
import { Button, Group, Txt } from "../../ui/kit";
import { Toggle } from "../../ui/Toggle";

const reasons: Record<string, string> = {
  fork_requires_idle: "Stop the current work and answer what it asked first.",
  fork_history_limit: "This chat is too long to copy up to here.",
  copied_history_unavailable: "There is nothing before this message to copy.",
  fork_boundary_unavailable: "This message can no longer be a starting point.",
};

interface Preview {
  canRewind: boolean;
  files: string[];
}

/**
 * Edit and send again, as on the Mac (desktop EditDialog): a new chat starts with the
 * conversation before this message and sends the edit; this chat stays as it is. Restoring files
 * is a separate choice. Every step reuses one attempt id, so tapping again after a lost reply
 * never starts a second chat.
 */
export default function EditMessage() {
  const { id, turnId } = useLocalSearchParams<{ id: string; turnId: string }>();
  const { c } = useTheme();
  const snapshot = useSnapshot();
  const online = useClient((state) => state.status === "online");
  const thread = snapshot.entities.thread?.find((row) => row.id === id);
  const original = transcript(snapshot, id).find(
    (row) => row.kind === "user" && row.turnId === turnId,
  );
  const sessionId = text(threadSession(snapshot, id)?.id);
  const [draft, setDraft] = useState(original?.text ?? "");
  const [restore, setRestore] = useState(true);
  const [files, setFiles] = useState<Preview>();
  const [blocked, setBlocked] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const attempt = useRef<string | undefined>(undefined);

  useEffect(() => {
    const client = useLink.getState().client?.getState();
    if (!client) return;
    let live = true;
    const boundary = { kind: "before_user", turnId };
    client
      .call("thread.forkPreview", { id, kind: "copied", boundary })
      .then((value) => {
        const row = (value ?? {}) as { available?: boolean; reason?: string };
        if (live && row.available === false)
          setBlocked(reasons[text(row.reason)] ?? "A new chat cannot start from this message.");
      })
      .catch(() => live && setBlocked("A new chat cannot start from here right now."));
    if (sessionId)
      client
        .call("session.rewind", { id: sessionId, turnId, dryRun: true, confirmed: false })
        .then((value) => {
          const row = (value ?? {}) as { canRewind?: boolean; files?: unknown };
          if (live)
            setFiles({
              canRewind: row.canRewind === true,
              files: Array.isArray(row.files) ? row.files.filter((f) => typeof f === "string") : [],
            });
        })
        .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [id, turnId, sessionId]);

  const restorable = !!files?.canRewind && files.files.length > 0;
  const send = async () => {
    const client = useLink.getState().client?.getState();
    if (!client) return;
    attempt.current ??= newId("edit");
    setWorking(true);
    setError("");
    try {
      if (restorable && restore)
        await client.call(
          "session.rewind",
          { id: sessionId, turnId, dryRun: false, confirmed: true },
          `${attempt.current}:rewind`,
        );
      const operation = (await client.call(
        "thread.fork",
        {
          id,
          title: `${text(thread?.title) || "Chat"} · edited`,
          kind: "copied",
          boundary: { kind: "before_user", turnId },
        },
        `${attempt.current}:fork`,
      )) as { state?: string; childThreadId?: string };
      const child = text(operation.childThreadId);
      if (operation.state !== "ready" || !child) throw new Error("fork_not_ready");
      await client.call(
        "turn.send",
        { threadId: child, input: [{ type: "text", text: draft.trim() }], mode: "queue" },
        `${attempt.current}:send`,
      );
      router.dismiss();
      router.push(`/chat/${child}`);
    } catch {
      // The draft stays, and the next tap replays the same attempt.
      setError("The new chat was not confirmed. Try again; it will not start a second one.");
    } finally {
      setWorking(false);
    }
  };

  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      style={{ backgroundColor: c["bg-page"] }}
      contentContainerStyle={styles.page}
    >
      <View style={styles.head}>
        <Button kind="plain" label="Cancel" disabled={working} onPress={() => router.back()} />
        <Txt v="cardTitle" accessibilityRole="header">
          Edit and send again
        </Txt>
        <Button
          kind="plain"
          label={working ? "Sending…" : "Send"}
          a11y="Send in a new chat"
          disabled={working || !online || !!blocked || !draft.trim() || !original}
          onPress={() => void send()}
        />
      </View>
      <OfflineBanner />
      <Txt v="meta" tone="muted">
        A new chat starts from before this message. This chat stays as it is.
      </Txt>
      <TextInput
        value={draft}
        onChangeText={setDraft}
        multiline
        autoFocus
        editable={!working}
        accessibilityLabel="Message"
        style={[
          styles.input,
          { color: c.text, borderColor: c["border-strong"], backgroundColor: c["bg-raised"] },
        ]}
      />
      {restorable ? (
        <Group>
          <Toggle
            label="Restore files to before this"
            note={`${files.files.length} ${files.files.length === 1 ? "file" : "files"} · this chat sees them too`}
            value={restore}
            disabled={working}
            onChange={setRestore}
            last
          />
        </Group>
      ) : null}
      {blocked ? <Txt tone="danger">{blocked}</Txt> : null}
      {error ? (
        <Txt tone="danger" accessibilityRole="text">
          {error}
        </Txt>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 20, gap: 12 },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  input: {
    fontFamily: sans,
    fontSize: 15,
    minHeight: 120,
    maxHeight: 280,
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 12,
    textAlignVertical: "top",
  },
});

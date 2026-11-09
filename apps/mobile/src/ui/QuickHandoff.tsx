import { errorText } from "@zoltbot/ui/quick-chat/data";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { text } from "../data/view";
import { useClient, useSnapshot } from "../state/link";
import { sans, useTheme } from "../theme";
import { Button, Card, Segmented, Txt } from "./kit";

/**
 * "Continue in workspace" from the phone: review the brief, pick a workspace and profile, and
 * open a normal workspace chat with the brief waiting in its composer. Nothing is sent here.
 */
export function QuickHandoff({ chatId, onClose }: { chatId: string; onClose(): void }) {
  const { c } = useTheme();
  const snapshot = useSnapshot();
  const call = useClient((state) => state.call);
  const projects = (snapshot.entities.project ?? []).filter((row) => !row.archived);
  const profiles = (snapshot.entities.agent ?? []).filter(
    (row) => row.kind === "profile" && !row.hidden && !row.archived,
  );
  const [projectId, setProjectId] = useState(text(projects[0]?.id));
  const [profileId, setProfileId] = useState(text(profiles[0]?.id));
  const [brief, setBrief] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    (call("quickChat.handoffPreview", { id: chatId }) as Promise<{ brief: string }>).then(
      (result) => live && setBrief(result.brief),
      (failure) => live && setError(errorText(failure)),
    );
    return () => {
      live = false;
    };
  }, [call, chatId]);
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const result = (await call("quickChat.handoff", {
        id: chatId,
        projectId,
        profileId,
        brief,
        confirmed: true,
      })) as { threadId: string; brief: string };
      onClose();
      router.push({ pathname: "/chat/[id]", params: { id: result.threadId, draft: result.brief } });
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card label="Continue in workspace">
      <Txt v="cardTitle">Continue in workspace</Txt>
      <Txt tone="muted">
        Creates a normal chat with the profile you choose. The brief waits for you to review and
        send there; the profile's usual permissions apply.
      </Txt>
      {error ? <Txt>{error}</Txt> : null}
      {projects.length && profiles.length ? (
        <>
          <Segmented
            label="Workspace"
            value={projectId}
            onChange={setProjectId}
            options={projects
              .slice(0, 4)
              .map((row) => ({ value: text(row.id), label: text(row.name) }))}
          />
          <Segmented
            label="Profile"
            value={profileId}
            onChange={setProfileId}
            options={profiles
              .slice(0, 4)
              .map((row) => ({ value: text(row.id), label: text(row.name) }))}
          />
          <TextInput
            value={brief}
            onChangeText={setBrief}
            multiline
            accessibilityLabel="Brief"
            style={[
              styles.brief,
              { color: c.text, borderColor: c["border-strong"], backgroundColor: c["bg-raised"] },
            ]}
          />
          <View style={styles.row}>
            <Button label="Cancel" kind="plain" onPress={onClose} />
            <Button
              label="Create workspace chat"
              disabled={busy || !brief.trim() || !projectId || !profileId}
              onPress={() => void submit()}
            />
          </View>
        </>
      ) : (
        <Txt>Create a workspace and a profile on your Mac first.</Txt>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  brief: {
    fontFamily: sans,
    minHeight: 160,
    maxHeight: 280,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
  },
  row: { flexDirection: "row", gap: 8, justifyContent: "flex-end" },
});

import { useState } from "react";
import { Alert, View } from "react-native";
import type { Row } from "../data/transport";
import { text } from "../data/view";
import { useAction } from "../state/actions";
import { Button, Txt } from "./kit";
export function WorktreeChanges({ task, online }: { task: Row; online: boolean }) {
  const [changes, setChanges] = useState<Row>();
  const { run, busy } = useAction();
  if (task.workspaceMode !== "worktree") return null;
  return (
    <View style={{ gap: 8 }}>
      <Txt v="meta">Separate worktree · Same location on resume</Txt>
      <Button
        label="Inspect changes"
        disabled={!online || busy}
        onPress={async () => {
          const result = await run("task.changes", { id: task.id });
          if (result) setChanges(result as Row);
        }}
      />
      {changes ? (
        <>
          <Txt v="meta">
            Base {text(changes.base)} · Head {text(changes.head)}
          </Txt>
          <Txt v="code">{text(changes.status) || "No uncommitted changes"}</Txt>
          <Txt v="code">{text(changes.patch) || "No tracked changes"}</Txt>
        </>
      ) : null}
      <Button
        label="Continue on your Mac"
        onPress={() =>
          Alert.alert(
            "Continue on your Mac",
            `Open Tasks and choose “${text(task.title)}” to create a review commit, integrate, archive or restore. Your task and review state stay saved.`,
          )
        }
      />
    </View>
  );
}

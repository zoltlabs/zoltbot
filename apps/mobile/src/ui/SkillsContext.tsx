import type { SkillEntryView, SkillSnapshotView } from "@zoltbot/protocol";
import { router } from "expo-router";
import { useState } from "react";
import { Alert, View } from "react-native";
import type { Row } from "../data/transport";
import { useAction } from "../state/actions";
import { Button, Txt } from "./kit";

/** Portable inspection and narrowing; host filesystem operations stay on the Mac. */
export function SkillsContext({ task, online }: { task: Row; online: boolean }) {
  const [data, setData] = useState<{
    snapshot: SkillSnapshotView | null;
    current: SkillEntryView[];
  }>();
  const { run, busy } = useAction();
  return (
    <View style={{ gap: 8 }}>
      <Button
        label="Inspect skills"
        disabled={!online || busy}
        onPress={async () => {
          const result = await run("skill.context", { taskId: task.id });
          if (result) setData(result as typeof data);
        }}
      />
      {data && !data.snapshot ? <Txt v="meta">No managed skills recorded at start.</Txt> : null}
      {data?.snapshot?.skills.map((skill) => (
        <View key={skill.skillId} style={{ gap: 8 }}>
          <Txt v="bodyMedium">
            {skill.name} · v{skill.revision} · Since start
          </Txt>
          <Txt v="meta">
            Enabled · Installed {skill.installedPath ? "yes" : "Not reported"} · Provider loaded{" "}
            {skill.reportedLoaded ? "yes" : "Not reported"}
          </Txt>
          {(data.current.find((entry) => entry.id === skill.skillId)?.current_revision ??
            skill.revision) > skill.revision ? (
            <Txt v="meta">A newer version is available for new sessions.</Txt>
          ) : null}
          <Button
            label={`Disable ${skill.name} for future sessions`}
            disabled={!online || busy}
            onPress={() =>
              Alert.alert(
                "Disable skill for future sessions?",
                "This native session keeps the version it started with. Other profiles are unchanged.",
                [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Disable",
                    onPress: () => {
                      const node = task.node as { id?: string } | undefined;
                      void run("skill.access", {
                        profileId: data.snapshot?.profileId,
                        scopeId: node?.id ?? task.projectId,
                        skillId: skill.skillId,
                        revision: skill.revision,
                        enabled: false,
                        confirmed: false,
                      });
                    },
                  },
                ],
              )
            }
          />
        </View>
      ))}
      <Button label="Manage skills" onPress={() => router.push("/skills")} />
    </View>
  );
}

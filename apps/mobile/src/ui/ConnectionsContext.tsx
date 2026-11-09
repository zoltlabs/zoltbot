import { compareSessions } from "@zoltbot/protocol";
import { router } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import type { Row } from "../data/transport";
import { useAction } from "../state/actions";
import { useSnapshot } from "../state/link";
import { Button, Txt } from "./kit";

export function ConnectionsContext({ task, online }: { task: Row; online: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const snapshot = useSnapshot();
  const { run, busy } = useAction();
  const session = snapshot.entities.session
    ?.filter((row) => row.threadId === task.threadId)
    .sort(compareSessions)[0];
  const config = snapshot.entities.settings?.find(
    (row) => row.key === `runtime.configuration.${session?.id}`,
  )?.value as
    | {
        launchManifest?: {
          profileId: string;
          connections: { id: string; name: string; version: number }[];
        };
      }
    | undefined;
  const manifest = config?.launchManifest;
  return (
    <View style={{ gap: 8 }}>
      <Button
        label={expanded ? "Hide connections" : "Inspect connections"}
        onPress={() => setExpanded(!expanded)}
      />
      {expanded ? (
        <>
          {!manifest?.connections.length ? (
            <Txt v="meta">No managed connections recorded at start.</Txt>
          ) : null}
          {manifest?.connections.map((connection) => (
            <View key={connection.id} style={{ gap: 8 }}>
              <Txt v="bodyMedium">
                {connection.name} · v{connection.version} · Attached at start
              </Txt>
              <Txt v="meta">
                Provider health: Not reported. Existing native sessions retain their launch inputs.
              </Txt>
              <Button
                label={`Disable ${connection.name} for future sessions`}
                disabled={!online || busy}
                onPress={() => {
                  void run("connection.disable", {
                    id: connection.id,
                    profileId: manifest.profileId,
                  });
                }}
              />
            </View>
          ))}
          <Button label="Manage connections" onPress={() => router.push("/connections")} />
        </>
      ) : null}
    </View>
  );
}

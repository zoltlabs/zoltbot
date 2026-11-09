import { router } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import type { Row } from "../data/transport";
import { useSnapshot } from "../state/link";
import { Button, Txt } from "./kit";

export function KnowledgeContext({ task }: { task: Row }) {
  const snapshot = useSnapshot();
  const [expanded, setExpanded] = useState(false);
  const pack = snapshot.entities.contextPack?.find((row) => row.taskId === task.id);
  const included = (pack?.included ?? []) as { id: string; revision: number; text: string }[];
  const excluded = (pack?.excluded ?? []) as { id: string; reason: string }[];
  const changed = included.some((item) =>
    snapshot.entities.knowledge?.some(
      (row) => row.id === item.id && Number(row.revision) > item.revision,
    ),
  );
  return (
    <View style={{ gap: 8 }}>
      <Button
        label={expanded ? "Hide knowledge context" : "Knowledge · Session inputs"}
        onPress={() => setExpanded(!expanded)}
      />
      {expanded ? (
        <>
          <Txt v="meta">
            {pack
              ? `Since start · ${Number(pack.tokenEstimate)} estimated tokens`
              : "Preview: inputs are checked at start"}
          </Txt>
          {changed ? (
            <Txt>Changed since start. This session keeps its original knowledge.</Txt>
          ) : null}
          {included.map((item) => (
            <View key={item.id}>
              <Txt v="meta">
                {item.id} · v{item.revision}
              </Txt>
              <Txt>{item.text}</Txt>
            </View>
          ))}
          {!included.length ? <Txt v="meta">No frozen knowledge reported.</Txt> : null}
          {excluded.map((item) => (
            <Txt v="meta" key={item.id}>
              {item.id}: {item.reason.replaceAll("_", " ")}
            </Txt>
          ))}
          <Button label="Edit knowledge" onPress={() => router.push("/knowledge")} />
        </>
      ) : null}
    </View>
  );
}

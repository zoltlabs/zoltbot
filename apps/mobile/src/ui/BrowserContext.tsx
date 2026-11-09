import { useState } from "react";
import { Alert, View } from "react-native";
import type { Row } from "../data/transport";
import { useAction } from "../state/actions";
import { Button, Txt } from "./kit";
/** Binary artifacts stay on the authenticated desktop path; the relay carries bounded metadata. */
export function BrowserContext({ task, online }: { task: Row; online: boolean }) {
  const [data, setData] = useState<{
    health: string;
    evidence: {
      id: string;
      revision: number;
      generation: number;
      check: string;
      outcome: string;
      inspection: string;
      observed?: boolean;
    }[];
  }>();
  const { run, busy } = useAction();
  if (!task.browser) return null;
  return (
    <View style={{ gap: 8 }}>
      <Button
        label="Inspect browser evidence"
        disabled={!online || busy}
        onPress={async () => {
          const result = await run("browser.task", { id: task.id });
          if (result) setData(result as typeof data);
        }}
      />
      {data ? (
        <>
          <Txt v="meta">Browser: {data.health}. URL association is user or agent supplied.</Txt>
          {data.evidence.map((e) => (
            <Txt key={e.id} v="meta">
              Revision {e.revision}, browser {e.generation}: {e.check} · {e.outcome} (agent
              reported).{" "}
              {e.observed
                ? "Observed image-tool delivery"
                : e.inspection === "agent_reported"
                  ? "Agent reported inspection"
                  : "Inspection not reported"}
              .
            </Txt>
          ))}
        </>
      ) : null}
      <Button
        label="View captures on your Mac"
        onPress={() =>
          Alert.alert(
            "Continue on your Mac",
            "Open this task in Zoltbot to view images, set up, stop or reopen its browser. Mobile supports metadata only; image bytes are not relayed.",
          )
        }
      />
    </View>
  );
}

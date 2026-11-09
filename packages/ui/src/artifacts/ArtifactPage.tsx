import { ArtifactSchema, parse } from "@zoltbot/protocol";
import type { ChatConnection } from "../chat/types.js";
import { useShell } from "../state.js";
import { ArtifactPanel } from "./Artifacts.js";
export default function ArtifactPage({
  connection,
  id,
}: {
  connection: ChatConnection;
  id: string;
}) {
  const row = connection.snapshot.entities.artifact?.find((a) => a.id === id);
  if (!row) return <p>Artifact not found on this Mac.</p>;
  const artifact = parse(ArtifactSchema, row);
  const close = () => {
    const shell = useShell.getState();
    if (connection.snapshot.entities.thread?.some((t) => t.id === artifact.threadId))
      shell.openThread(artifact.threadId);
    else if (artifact.projectId) shell.openScope({ type: "project", id: artifact.projectId });
    else shell.navigate("Projects");
  };
  return (
    <section>
      <h1>Artifact</h1>
      <ArtifactPanel connection={connection} artifact={artifact} close={close} />
    </section>
  );
}

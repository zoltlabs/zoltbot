import { randomUUID } from "node:crypto";
import type { DaemonClient, Row } from "./daemon-client";
import { serviceTiers } from "./mapping";

/**
 * A5: Fast mode is stored on the agent, so its next sessions start on the faster tier. A live
 * session switches first, from its next turn; the agent is updated only once it has.
 */
export async function setFastMode(
  client: DaemonClient,
  agentId: string,
  session: Row | undefined,
  on: boolean,
): Promise<void> {
  const tier = serviceTiers(session)[0];
  if (tier && (session?.state === "ready" || session?.state === "running"))
    await client.call(
      "session.setServiceTier",
      { id: session.id, tier: on ? tier : null },
      randomUUID(),
    );
  await client.call("agent.update", { id: agentId, changes: { fastMode: on } }, randomUUID());
}

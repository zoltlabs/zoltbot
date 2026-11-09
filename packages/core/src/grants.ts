import type { Grant } from "@zoltbot/protocol";

export interface GrantOperation {
  actorId: string;
  capability: Grant["capability"];
  targetAgentId: string;
  /** Resolved by the daemon from stored project membership, never from tool arguments. */
  targetProjectIds: readonly string[];
  /** Hidden, archived, and missing targets are unavailable even with a wildcard grant. */
  targetAvailable: boolean;
}

/** File 13 removes implicit peer messaging. Read current grants for every operation. */
export function matchingGrant(
  grants: readonly Grant[],
  operation: GrantOperation,
): string | undefined {
  if (!operation.targetAvailable) return undefined;
  return grants.find(
    (grant) =>
      grant.holderAgentId === operation.actorId &&
      grant.capability === operation.capability &&
      grant.revokedAt === undefined &&
      (grant.target === operation.targetAgentId ||
        grant.target === "*" ||
        operation.targetProjectIds.includes(grant.target)),
  )?.id;
}

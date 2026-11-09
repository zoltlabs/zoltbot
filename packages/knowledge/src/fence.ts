import { createHash } from "node:crypto";
import type { DomainState } from "@zoltbot/core";
import type { Scope } from "@zoltbot/protocol";
import { eligibleKnowledge } from "./retrieval.js";

/** Eligible metadata only: unrelated projects never perturb launch identities. */
export function knowledgeScopeHash(state: DomainState, scope: Scope) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        eligibleKnowledge(state, scope).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      ),
    )
    .digest("hex");
}

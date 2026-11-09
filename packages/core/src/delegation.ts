import type { CommandContext, Outcome } from "./commands.js";
import type { DomainState } from "./projectors.js";
import { briefTeam, type TeamActor } from "./team.js";

export type DelegatingActor = TeamActor;
/** A manager starts one new chat in its own team. See briefTeam for the full chain of command. */
export function delegateChat(
  state: DomainState,
  actor: DelegatingActor,
  input: { title: string; brief: string; profileId: string },
  childId: string,
  context: CommandContext,
): Outcome {
  return briefTeam(state, actor, input, { childId, messageId: `${childId}:brief` }, context);
}

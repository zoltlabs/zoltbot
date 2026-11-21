// C11: per-agent switch for the finish check. One settings row per agent; absent means on.
export const AGENT_CONTINUE_PREFIX = "agent.continue.";
export const agentContinueKey = (agentId: string) => `${AGENT_CONTINUE_PREFIX}${agentId}`;
/** Whether the agent continues replies that end on a promise. Only `false` turns it off. */
export const continuesTurns = (value: unknown) => value !== false;

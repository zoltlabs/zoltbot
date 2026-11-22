import { describe, expect, it, vi } from "vitest";
import { ROUTINE_CHANNELS as C } from "../shared/routines";
import { routineHandlers } from "./routines-service";

function client() {
  const call = vi.fn(async (method: string, _params?: unknown, _commandId?: string) =>
    method === "routine.starters"
      ? {
          items: [{ id: "weekly-inbox", name: "Weekly inbox summary", projectId: "p" }, { bad: 1 }],
        }
      : {},
  );
  const rows = (kind: string) =>
    kind === "agent"
      ? [
          { id: "claude-agent", kind: "profile", definitionId: "claude" },
          { id: "codex-agent", kind: "profile", definitionId: "codex" },
          { id: "old", kind: "profile", definitionId: "codex", archived: true },
        ]
      : [{ id: "p", defaultAgentId: null }];
  return { call, rows };
}

describe("starter jobs over IPC (D5)", () => {
  it("lists the jobs the daemon offers", async () => {
    const handlers = routineHandlers(client() as never);
    expect(await handlers[C.routinesStarters]?.(undefined)).toEqual([
      { id: "weekly-inbox", name: "Weekly inbox summary" },
    ]);
  });

  it("adds a job with the agent picked in setup, else the usual first choice", async () => {
    const fake = client();
    const handlers = routineHandlers(fake as never);
    await handlers[C.routinesAddStarter]?.({ id: "weekly-inbox", provider: "codex" });
    await handlers[C.routinesAddStarter]?.({ id: "weekly-inbox" });
    const adds = fake.call.mock.calls.filter(([method]) => method === "routine.createStarter");
    expect(adds.map(([, params]) => (params as { profileId: string }).profileId)).toEqual([
      "codex-agent",
      "claude-agent",
    ]);
    expect(adds[0]?.[1]).toMatchObject({ jobId: "weekly-inbox", timezone: expect.any(String) });
    expect(adds[0]?.[2]).toEqual(expect.any(String));
  });

  it("says why a job can't be added", async () => {
    const fake = client();
    fake.call.mockImplementation(async (method: string) => {
      if (method === "routine.createStarter") throw new Error("starter_unavailable");
      return { items: [] };
    });
    await expect(
      routineHandlers(fake as never)[C.routinesAddStarter]?.({ id: "weekly-inbox" }),
    ).rejects.toThrow("Its app isn't connected any more.");
  });
});

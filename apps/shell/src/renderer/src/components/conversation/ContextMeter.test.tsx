import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, ContextUsage } from "../../../../shared/ipc";
import type { BotProfile } from "../../data";
import { ToastRegion } from "../../kit";
import { ContextBar, ContextMeter } from "./ContextMeter";
import { contextAlmostFull, contextPercent, createContextUsage } from "./context";

describe("context thresholds", () => {
  it("rounds to a percent, caps at 100 and warns from 80%", () => {
    expect(contextPercent({ used: 85_000, size: 100_000 })).toBe(85);
    expect(contextPercent({ used: 120, size: 100 })).toBe(100);
    expect(contextAlmostFull({ used: 79, size: 100 })).toBe(false);
    expect(contextAlmostFull({ used: 80, size: 100 })).toBe(true);
    expect(contextAlmostFull(null)).toBe(false);
  });
});

describe("context meter and bar", () => {
  let usage: ContextUsage | null;
  let listener: ((event: AgentEvent) => void) | undefined;
  const bot = { id: "chief", profileId: "profile", projectId: "project" } as BotProfile;

  beforeEach(() => {
    usage = { used: 85_000, size: 100_000 };
    Object.assign(window, {
      openbot: {
        agent: {
          readContext: vi.fn(async () => usage),
          compact: vi.fn(async () => {
            usage = { used: 12_000, size: 100_000 };
          }),
          createBot: vi.fn(async () => ({ id: "fresh" })),
          onEvent: vi.fn((next: (event: AgentEvent) => void) => {
            listener = next;
            return () => undefined;
          }),
        },
      },
    });
  });

  function renderBoth(onSelectAgent = vi.fn()) {
    render(() => {
      const context = createContextUsage(() => "chief");
      return (
        <>
          <ContextMeter context={context} />
          <ContextBar context={context} bot={bot} onSelectAgent={onSelectAgent} />
          <ToastRegion />
        </>
      );
    });
    return onSelectAgent;
  }

  it("shows how full the context is and offers Compact at 80%", async () => {
    renderBoth();
    const meter = await screen.findByRole("meter", { name: "Context 85% full" });
    expect(meter).toHaveAttribute("aria-valuenow", "85");
    const bar = screen.getByRole("region", { name: "Context almost full" });
    fireEvent.click(screen.getByRole("button", { name: "Compact" }));
    expect(window.openbot.agent.compact).toHaveBeenCalledWith("chief");
    await waitFor(() => expect(bar).not.toBeInTheDocument());
    expect(screen.getByRole("meter", { name: "Context 12% full" })).toBeInTheDocument();
    expect(await screen.findByRole("status")).toHaveTextContent("Compacted");
  });

  it("starts a new chat with the same agent and project", async () => {
    const onSelectAgent = renderBoth();
    fireEvent.click(await screen.findByRole("button", { name: "New chat" }));
    await waitFor(() => expect(onSelectAgent).toHaveBeenCalledWith("fresh"));
    expect(window.openbot.agent.createBot).toHaveBeenCalledWith({
      profileId: "profile",
      projectId: "project",
    });
  });

  it("hides when the agent doesn't report context and rereads after a turn", async () => {
    usage = null;
    renderBoth();
    await Promise.resolve();
    expect(screen.queryByRole("meter")).toBeNull();
    usage = { used: 40_000, size: 100_000 };
    listener?.({
      type: "turn-completed",
      botId: "chief",
      threadId: "chief",
      turnId: "t",
      status: "completed",
    });
    expect(await screen.findByRole("meter", { name: "Context 40% full" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Context almost full" })).toBeNull();
  });
});

import { describe, expect, it, vi } from "vitest";
import { BridgeError, type InboundMessage } from "./adapter.js";
import { FakeBridgeAdapter } from "./fake.js";
import { allowed, bridgedText, routeFor, splitText } from "./router.js";
import { bridgeSupervisor, type SupervisorStatus } from "./supervisor.js";

const message = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  id: "m1",
  place: { id: "C1", label: "#support", direct: false },
  sender: { id: "U1", name: "Priya" },
  text: "hello",
  reply: {},
  ...over,
});
const routes = [
  {
    id: "r1",
    from: { id: "C1", label: "#support" },
    to: { kind: "chat" as const, threadId: "t1" },
    allow: [{ id: "U1", name: "Priya" }],
  },
  {
    id: "r2",
    from: { id: "dm", label: "Direct messages" },
    to: { kind: "chat" as const, threadId: "t2" },
    allow: [],
  },
];

describe("routing", () => {
  it("picks the place's route, then the direct-message route for DMs", () => {
    expect(routeFor({ routes }, message())?.id).toBe("r1");
    expect(
      routeFor({ routes }, message({ place: { id: "D9", label: "", direct: true } }))?.id,
    ).toBe("r2");
    expect(routeFor({ routes }, message({ place: { id: "C2", label: "", direct: false } }))).toBe(
      undefined,
    );
  });

  it("lets only listed people talk; an empty list lets nobody", () => {
    expect(allowed(routes[0] as never, "U1")).toBe(true);
    expect(allowed(routes[0] as never, "U2")).toBe(false);
    expect(allowed(routes[1] as never, "U1")).toBe(false);
  });

  it("names the sender and app, so a leading slash can't run a command", () => {
    expect(bridgedText("slack", message({ text: "/clear" }))).toBe(
      "Message from Priya on Slack in #support:\n/clear",
    );
    expect(
      bridgedText(
        "telegram",
        message({ sender: { id: "7", name: "A\nB" }, place: { id: "7", label: "", direct: true } }),
      ),
    ).toBe("Message from A B on Telegram:\nhello");
    expect(
      bridgedText("slack", message({ sender: { id: "U2", name: "/compact" } })).startsWith("/"),
    ).toBe(false);
  });

  it("splits long replies at paragraph breaks and never loses text", () => {
    const text = `${"a".repeat(30)}\n\n${"b".repeat(30)}\n\n${"c ".repeat(40)}`;
    const parts = splitText(text, 50);
    expect(parts.every((part) => part.length <= 50)).toBe(true);
    expect(parts[0]).toBe("a".repeat(30));
    expect(parts.join(" ").replace(/\s+/g, "")).toBe(text.replace(/\s+/g, ""));
    expect(splitText("x".repeat(120), 50)).toEqual([
      "x".repeat(50),
      "x".repeat(50),
      "x".repeat(20),
    ]);
  });
});

describe("supervisor", () => {
  it("retries a network failure with growing waits and stops on a refused token", async () => {
    const delays: number[] = [];
    const queued: (() => void)[] = [];
    const statuses: SupervisorStatus[] = [];
    const fake = new FakeBridgeAdapter();
    fake.failNext = new BridgeError("network");
    const supervisor = bridgeSupervisor({
      create: async () => fake,
      onStatus: (_id, status) => statuses.push(status),
      onMessage: () => {},
      initialMs: 100,
      maxMs: 300,
      timers: {
        set: (run, ms) => {
          delays.push(ms);
          queued.push(run);
          return queued.length;
        },
        clear: () => {},
      },
    });
    await supervisor.sync([{ id: "b", enabled: true, fingerprint: "1" }]);
    await vi.waitFor(() => expect(statuses.at(-1)?.state).toBe("reconnecting"));
    fake.failNext = new BridgeError("network");
    queued.shift()?.();
    await vi.waitFor(() => expect(delays).toEqual([100, 200]));
    queued.shift()?.();
    await vi.waitFor(() =>
      expect(statuses.at(-1)).toEqual({ state: "connected", account: "Fake workspace" }),
    );
    fake.failNext = new BridgeError("token_refused");
    fake.drop();
    expect(delays.at(-1)).toBe(100);
    queued.shift()?.();
    await vi.waitFor(() =>
      expect(statuses.at(-1)).toEqual({ state: "stopped", problem: "token_refused" }),
    );
    await supervisor.close();
  });

  it("restarts when the token changes and stops a disabled bridge", async () => {
    const adapters: FakeBridgeAdapter[] = [];
    const statuses: SupervisorStatus[] = [];
    const supervisor = bridgeSupervisor({
      create: async () => {
        const adapter = new FakeBridgeAdapter();
        adapters.push(adapter);
        return adapter;
      },
      onStatus: (_id, status) => statuses.push(status),
      onMessage: () => {},
    });
    await supervisor.sync([{ id: "b", enabled: true, fingerprint: "1" }]);
    await vi.waitFor(() => expect(adapters[0]?.started).toBe(1));
    await supervisor.sync([{ id: "b", enabled: true, fingerprint: "1" }]);
    expect(adapters).toHaveLength(1);
    await supervisor.sync([{ id: "b", enabled: true, fingerprint: "2" }]);
    await vi.waitFor(() => expect(adapters[1]?.started).toBe(1));
    expect(adapters[0]?.stopped).toBe(1);
    await supervisor.sync([{ id: "b", enabled: false, fingerprint: "2" }]);
    expect(adapters[1]?.stopped).toBe(1);
    expect(statuses.at(-1)).toEqual({ state: "stopped" });
    await supervisor.close();
  });
});

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AgentEvent, UserInput } from "@zoltbot/protocol";
import { describe, expect, it, vi } from "vitest";
import { claudeFactory } from "./claude-conformance-factory.js";
import { codexFactory } from "./codex-conformance-factory.js";

const input: UserInput = [{ type: "text", text: "normal" }];
async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(check()).toBe(true);
}
const turns = (trace: AgentEvent[]) => trace.filter((e) => e.t === "turn.done").length;

describe("A5 fast mode reaches the provider", () => {
  it("Claude turns fast mode on and off through flag settings", async () => {
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const ctx = await claudeFactory("service_tier");
    try {
      await until(() => ctx.trace.some((e) => e.t === "session.ready"));
      expect(ctx.session.capabilities.serviceTiers).toEqual(["fast"]);
      const live = () =>
        JSON.parse(readFileSync(path.join(ctx.cwd ?? "", "live-model.json"), "utf8"));
      await ctx.session.setServiceTier?.("fast");
      expect(live().fastMode).toBe(true);
      await ctx.session.setServiceTier?.(null);
      expect(live().fastMode).toBe(false);
    } finally {
      await ctx.dispose();
      warn.mockRestore();
    }
  });

  it("Codex sends the tier on the next turn only", async () => {
    const ctx = await codexFactory("service_tier");
    const file = path.join(ctx.cwd ?? "", "service-tier.json");
    try {
      expect(ctx.session.capabilities.serviceTiers).toEqual(["priority"]);
      await ctx.session.setServiceTier?.("priority");
      await ctx.session.send(input, "queue");
      await until(() => turns(ctx.trace) >= 1);
      expect(JSON.parse(readFileSync(file, "utf8"))).toBe("priority");
      await expect(ctx.session.setServiceTier?.("flex")).rejects.toThrow(
        "unsupported_service_tier",
      );
      await ctx.session.setServiceTier?.(null);
      await ctx.session.send(input, "queue");
      await until(() => turns(ctx.trace) >= 2);
      expect(JSON.parse(readFileSync(file, "utf8"))).toBeNull();
    } finally {
      await ctx.dispose();
    }
  });

  it("Codex without listed tiers offers none", async () => {
    const ctx = await codexFactory("open");
    try {
      expect(ctx.session.capabilities.serviceTiers).toBeUndefined();
      expect(existsSync(path.join(ctx.cwd ?? "", "service-tier.json"))).toBe(false);
    } finally {
      await ctx.dispose();
    }
  });
});

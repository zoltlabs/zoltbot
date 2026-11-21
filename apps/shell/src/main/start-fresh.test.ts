import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { confirmsStartFresh, START_FRESH_CHANNELS } from "../shared/start-fresh";
import { startFreshHandlers } from "./start-fresh";

function setup() {
  const folder = mkdtempSync(join(tmpdir(), "zoltbot-fresh-app-"));
  const preferences = join(folder, "preferences.json");
  writeFileSync(preferences, "{}");
  const order: string[] = [];
  const deps = {
    interruptAll: vi.fn(async () => void order.push("interrupt")),
    signOut: vi.fn(async () => void order.push("sign out")),
    call: vi.fn(async () => {
      order.push("mark");
      return { kept: ["/projects/app/.zoltbot", 4] };
    }),
    stopDaemon: vi.fn(async () => void order.push("stop")),
    appFiles: () => [preferences],
    clearStorage: vi.fn(async () => void order.push("storage")),
    relaunch: vi.fn(() => void order.push("relaunch")),
  };
  return { handlers: startFreshHandlers(deps), deps, order, preferences };
}

describe("start fresh", () => {
  it("accepts only the typed phrase", () => {
    expect(confirmsStartFresh("  Start Fresh ")).toBe(true);
    expect(confirmsStartFresh("start")).toBe(false);
  });

  it("refuses without the phrase and restarts only after the daemon marked its data", async () => {
    const { handlers, deps } = setup();
    await expect(handlers[START_FRESH_CHANNELS.run]?.("yes")).rejects.toThrow("not_confirmed");
    expect(deps.call).not.toHaveBeenCalled();
    await expect(handlers[START_FRESH_CHANNELS.restart]?.(undefined)).rejects.toThrow("not_run");
    expect(deps.stopDaemon).not.toHaveBeenCalled();
  });

  it("stops work, marks the data, then stops the daemon, deletes app files and relaunches", async () => {
    const { handlers, deps, order, preferences } = setup();
    expect(await handlers[START_FRESH_CHANNELS.run]?.("start fresh")).toEqual({
      kept: ["/projects/app/.zoltbot"],
    });
    expect(deps.call).toHaveBeenCalledWith("maintenance.startFresh", { confirm: "start fresh" });
    // Gone already, in case the owner quits instead of restarting.
    expect(existsSync(preferences)).toBe(false);
    await handlers[START_FRESH_CHANNELS.restart]?.(undefined);
    expect(order).toEqual(["interrupt", "sign out", "mark", "storage", "stop", "relaunch"]);
    expect(existsSync(preferences)).toBe(false);
  });
});

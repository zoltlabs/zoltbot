import { describe, expect, it } from "vitest";
import { ROUTINE_CHANNELS } from "../../shared/routines";
import { webAddressHandlers } from "./web-address-handlers";

const URL = "https://cloud.example.test/h/".concat("a".repeat(43));

function setup(answers: Record<string, (params: Record<string, unknown>) => unknown>) {
  const calls: [string, unknown][] = [];
  const copied: string[] = [];
  const client = {
    async call(method: string, params: unknown) {
      calls.push([method, params]);
      const answer = answers[method];
      if (!answer) throw new Error(`unexpected ${method}`);
      return answer(params as Record<string, unknown>);
    },
  };
  let next = 0;
  const handle = webAddressHandlers({
    client,
    copy: (text) => copied.push(text),
    commandId: () => `command-${next++}`,
  })[ROUTINE_CHANNELS.routinesWebAddress] as (input: unknown) => Promise<{ state: string }>;
  return { handle, calls, copied };
}

describe("web address actions on the Routines page", () => {
  it("copies the address without returning it; the daemon binds the routine", async () => {
    const { handle, calls, copied } = setup({
      "routine.webhookAddress": () => ({ state: "ready", url: URL }),
    });
    expect(await handle({ id: "hook", action: "copy" })).toEqual({ state: "copied" });
    expect(copied).toEqual([URL]);
    expect(await handle({ id: "hook", action: "rotate" })).toEqual({ state: "rotated" });
    expect(calls.map(([method]) => method)).toEqual([
      "routine.webhookAddress",
      "routine.webhookAddress",
    ]);
    expect(calls.at(-1)).toEqual(["routine.webhookAddress", { id: "hook", rotate: true }]);
  });

  it("sends a test, reports another Mac's address and turns failures into codes", async () => {
    const { handle, copied } = setup({
      "routine.webhookTest": () => ({ ok: true }),
      "routine.webhookAddress": () => ({ state: "elsewhere" }),
    });
    expect(await handle({ id: "hook", action: "test" })).toEqual({ state: "sent" });
    expect(await handle({ id: "hook", action: "copy" })).toEqual({ state: "elsewhere" });
    expect(copied).toEqual([]);
    const failing = setup({
      "routine.webhookTest": () => {
        throw new Error("webhook_test_rate_limited");
      },
      "routine.webhookAddress": () => {
        throw new Error("sign_in_required");
      },
    });
    await expect(failing.handle({ id: "hook", action: "test" })).rejects.toThrow(
      "web_address_busy",
    );
    await expect(failing.handle({ id: "hook", action: "copy" })).rejects.toThrow(
      "web_address_sign_in",
    );
    await expect(failing.handle({ id: "hook", action: "delete" })).rejects.toThrow(
      "Invalid request.",
    );
  });
});

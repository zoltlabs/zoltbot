import { expect, it } from "vitest";
import { interruptedLaunchConfiguration } from "./connections-delivery.js";

it("reuses an unclaimed frozen intent and refuses ambiguous native creation after a crash", () => {
  const config = { launchManifest: { id: "manifest" } };
  const state = {
    session: [
      { id: "session", threadId: "thread", generation: 1, startedAt: "2026-11-04T00:00:00Z" },
    ],
    settings: [{ key: "runtime.configuration.session", value: config }],
  };
  expect(interruptedLaunchConfiguration(state, "thread")).toEqual(config);
  state.settings.push({
    key: "runtime.launchClaim.session",
    value: true as unknown as typeof config,
  });
  expect(() => interruptedLaunchConfiguration(state, "thread")).toThrow("native_start_uncertain");
});

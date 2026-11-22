import { describe, it } from "vitest";
import { runConformance, scenarios } from "../../conformance/index.js";
import { createBoatApi, createBoatTarget } from "./index.js";

const apiKey = process.env.BOAT_API_KEY;

describe.skipIf(!apiKey)("Boat execution target against the hosted service", () => {
  it.each(scenarios)("passes conformance: %s", async (scenario) => {
    if (!apiKey) return;
    const target = createBoatTarget({ apiKey });
    const snapshots: string[] = [];
    const snapshot = target.snapshot;
    target.snapshot = async (ref) => {
      const saved = await snapshot(ref);
      snapshots.push(saved.id);
      return saved;
    };
    const [conformance] = await Promise.allSettled([runConformance(target, scenario, { slow: 3 })]);
    const api = createBoatApi(apiKey);
    const cleanup = await Promise.allSettled(
      snapshots.map((name) => api.deleteSavedSnapshot({ name })),
    );
    if (conformance.status === "rejected") throw conformance.reason;
    if (cleanup.some((result) => result.status === "rejected"))
      throw new Error("The disposable Boat snapshot could not be deleted.");
  }, 900_000);
});

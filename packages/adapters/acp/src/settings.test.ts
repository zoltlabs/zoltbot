import { expect, it } from "vitest";
import { AcpSettings } from "./settings.js";

it("uses advertised config ids and values, including grouped model choices", () => {
  const settings = new AcpSettings();
  settings.update([
    {
      id: "opaque-model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "small",
      options: [
        {
          group: "g",
          name: "Models",
          options: [
            { value: "small", name: "Small" },
            { value: "big", name: "Big" },
          ],
        },
      ],
    },
    {
      id: "opaque-effort",
      name: "Effort",
      category: "thought_level",
      type: "select",
      currentValue: "low",
      options: [
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
      ],
    },
  ]);
  expect(settings.selection("big", "high")).toEqual([
    { configId: "opaque-model", value: "big" },
    { configId: "opaque-effort", value: "high" },
  ]);
  expect(() => settings.selection("invented")).toThrow("unsupported_model_selection");
  expect(() => settings.selection("big", "invented")).toThrow("unsupported_effort");
  settings.update([]);
  expect(settings.models).toEqual([]);
});
it("uses the advertised mode config id instead of assuming a legacy mode method", () => {
  const settings = new AcpSettings();
  settings.update([
    {
      id: "opaque-mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: "build",
      options: [
        { value: "build", name: "Build" },
        { value: "plan", name: "Plan" },
      ],
    },
  ]);
  expect(settings.modes).toEqual(["build", "plan"]);
  expect(settings.modeSelection("plan")).toEqual({ configId: "opaque-mode", value: "plan" });
  expect(() => settings.modeSelection("invented")).toThrow("unsupported_mode");
});

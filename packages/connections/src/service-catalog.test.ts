import { afterEach, expect, it, vi } from "vitest";
import { recipeAuthorization } from "./recipes.js";
import { brokerOrigin } from "./service-catalog.js";

afterEach(() => vi.unstubAllEnvs());
it("disables broker authorization before making a request in local mode", async () => {
  vi.stubEnv("ZOLTBOT_BROKER_ORIGIN", "");
  expect(() => brokerOrigin()).toThrow("connection_broker_unavailable");
  await expect(
    recipeAuthorization("gmail", "https://gmail.googleapis.com/gmail/v1", "local"),
  ).rejects.toThrow("connection_broker_unavailable");
});
it("accepts explicit HTTPS origins while rejecting embedded credentials and paths", () => {
  vi.stubEnv("ZOLTBOT_BROKER_ORIGIN", "https://broker.example");
  expect(brokerOrigin()).toBe("https://broker.example");
  for (const value of [
    "http://broker.example",
    "https://user@broker.example",
    "https://broker.example/path",
  ]) {
    vi.stubEnv("ZOLTBOT_BROKER_ORIGIN", value);
    expect(() => brokerOrigin()).toThrow("connection_destination_denied");
  }
});

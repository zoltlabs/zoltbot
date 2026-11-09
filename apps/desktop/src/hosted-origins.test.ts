import { describe, expect, it } from "vitest";
import { hostedOrigins } from "./hosted-origins.js";

const official = JSON.stringify({
  name: "zoltbot",
  zoltbot: { hostedOrigin: "https://zoltbot.ai", relayUrl: "wss://relay.zoltbot.ai" },
});

describe("hosted origins", () => {
  it("leaves hosted services off without configuration", () => {
    expect(hostedOrigins({})).toEqual({ cloud: undefined, broker: undefined, relay: undefined });
    expect(hostedOrigins({}, JSON.stringify({ name: "zoltbot" }))).toEqual({
      cloud: undefined,
      broker: undefined,
      relay: undefined,
    });
  });

  it("uses the origin an official build was packaged with", () => {
    expect(hostedOrigins({}, official)).toEqual({
      cloud: "https://zoltbot.ai",
      broker: "https://zoltbot.ai",
      relay: "wss://relay.zoltbot.ai",
    });
  });

  it("lets explicit environment settings override the packaged origin", () => {
    expect(
      hostedOrigins(
        {
          ZOLTBOT_CLOUD_ORIGIN: "https://accounts.example.test",
          ZOLTBOT_BROKER_ORIGIN: "https://broker.example.test",
          ZOLTBOT_RELAY_URL: "wss://relay.example.test",
        },
        official,
      ),
    ).toEqual({
      cloud: "https://accounts.example.test",
      broker: "https://broker.example.test",
      relay: "wss://relay.example.test",
    });
  });
});

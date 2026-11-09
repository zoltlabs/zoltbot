import { expect, it } from "vitest";
import { acpFactory } from "./acp-conformance-factory.js";
import { claudeFactory } from "./claude-conformance-factory.js";
import { piFactory } from "./pi-conformance-factory.js";

for (const [provider, factory] of [
  ["claude", claudeFactory],
  ["pi", piFactory],
  ["acp", acpFactory()],
] as const)
  it(`exposes only advertised public commands from the ${provider} native handshake`, async () => {
    const fixture = await factory("stream");
    try {
      expect(fixture.session.capabilities.slashCommands).toContainEqual({
        name: "fixture",
        description: "Native fixture command",
      });
      expect(
        fixture.session.capabilities.slashCommands?.some(
          (command) => command.name === "zoltbot_ready",
        ),
      ).toBe(false);
      if (provider === "acp") {
        await fixture.session.send([{ type: "text", text: "commands_update" }], "queue");
        for (
          let i = 0;
          i < 200 &&
          !fixture.session.capabilities.slashCommands?.some(
            (command) => command.name === "updated",
          );
          i++
        )
          await new Promise((resolve) => setTimeout(resolve, 10));
        expect(
          fixture.trace.some(
            (event) =>
              event.t === "capabilities.updated" &&
              event.capabilities.slashCommands?.some((command) => command.name === "updated"),
          ),
        ).toBe(true);
      }
    } finally {
      await fixture.dispose();
    }
  });

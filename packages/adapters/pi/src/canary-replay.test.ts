import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { PiMapper } from "./mapping.js";

const messages = readFileSync("fixtures/pi/1.4.0/bundled-gate-local-provider.jsonl", "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line).message);
it("records the real bundled gate command, readiness proof, and denied tool execution", () => {
  expect(
    messages.some(
      (m) =>
        m.type === "extension_ui_request" &&
        m.method === "notify" &&
        m.message === "zoltbot_ready:bundled-spike",
    ),
  ).toBe(true);
  const commands = messages.find((m) => m.type === "response" && m.command === "get_commands").data
    .commands;
  expect(commands).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "zoltbot_ready", source: "extension" }),
    ]),
  );
  const dialogs = messages.filter(
    (m) => m.type === "extension_ui_request" && m.method === "confirm",
  );
  expect(dialogs).toHaveLength(2);
  expect(messages.filter((m) => m.type === "extension_ui_response")).toEqual([
    { type: "extension_ui_response", id: dialogs[0].id, confirmed: false },
    { type: "extension_ui_response", id: dialogs[1].id, cancelled: true },
  ]);
  let mapper = new PiMapper("first");
  const events = messages.flatMap((message) => {
    const result = mapper.frame(message);
    if (message.type === "agent_settled") mapper = new PiMapper("second");
    return result;
  });
  expect(events.filter((e) => e.t === "tool.done" && e.status === "denied")).toHaveLength(2);
  expect(events.filter((e) => e.t === "turn.done" && e.status === "completed")).toHaveLength(2);
});

import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it } from "vitest";

const schema = JSON.parse(
  readFileSync(
    new URL(import.meta.resolve("@agentclientprotocol/sdk/schema/v1/schema.json")),
    "utf8",
  ),
);
const validate = new Ajv2020({ strict: false, validateFormats: false }).compile({
  $defs: schema.$defs,
  $ref: "#/$defs/InitializeResponse",
});
for (const [provider, version] of [
  ["cursor", "2026.10.22-27dcf5f"],
  ["opencode", "1.19.4"],
  ["grok", "1.0.70"],
])
  it(`validates ${provider} real ACP initialization and keeps model prompts out`, () => {
    const raw = readFileSync(
      `fixtures/${provider}/${version}/initialize-session-no-auth.jsonl`,
      "utf8",
    );
    const records = raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const response = records.find((r) => r.direction === "stdout" && r.message.id === 1).message;
    expect(validate(response.result), JSON.stringify(validate.errors)).toBe(true);
    expect(response.result.protocolVersion).toBe(1);
    expect(response.result.agentCapabilities.mcpCapabilities.http).toBe(true);
    expect(
      records.some(
        (r) => r.message.method === "session/prompt" || r.message.method === "authenticate",
      ),
    ).toBe(false);
    expect(raw).not.toContain("synthetic-zoltbot-mcp-token");
    expect(raw).not.toContain("MacBook");
    const session = records.find((r) => r.direction === "stdout" && r.message.id === 2).message;
    if (provider === "opencode") {
      expect(session.result.sessionId).toBeTruthy();
      const mode = records
        .find((r) => r.direction === "stdout" && r.message.id === 3)
        .message.result.configOptions.find(
          (option: { category?: string }) => option.category === "mode",
        );
      expect(mode.currentValue).toBe("plan");
      const traffic = JSON.parse(
        readFileSync(`fixtures/${provider}/${version}/mcp-http-no-auth.json`, "utf8"),
      );
      expect(traffic.every((event: { authorized: boolean }) => event.authorized)).toBe(true);
      expect(traffic.map((event: { method: string }) => event.method)).toContain("tools/list");
    } else expect(session.error.code).toBe(-32000);
  });

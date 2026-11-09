import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it } from "vitest";
import { acpDefinitions } from "../definitions.js";
import { antigravityFlavor } from "./antigravity.js";

const antigravityDefinition = acpDefinitions.find((entry) => entry.id === "antigravity");
if (!antigravityDefinition) throw new Error("missing_definition");

it("uses the verified official worker route and only advertised explicit key authentication", () => {
  expect(antigravityDefinition.launch.args).toEqual(["acp", "--process-per-session"]);
  expect(antigravityDefinition.auth?.loginCommand).toEqual([]);
  expect(antigravityDefinition.defaults.permissionProfile).toBe("workspace_write");
  const flavor = antigravityFlavor();
  const methods = [
    { id: "gemini-api-key", name: "API key" },
    { id: "oauth-personal", name: "Google" },
  ];
  expect(flavor.chooseAuth?.(methods, {})).toBeUndefined();
  expect(flavor.chooseAuth?.([], { GEMINI_API_KEY: "synthetic" })).toBeUndefined();
  expect(flavor.chooseAuth?.(methods, { GEMINI_API_KEY: "synthetic" })).toEqual({
    methodId: "gemini-api-key",
  });
  expect(flavor.clientInfo).toBeUndefined();
});
it("validates the real isolated Antigravity handshake without credentials or prompts", () => {
  const schema = JSON.parse(
    readFileSync(
      new URL(import.meta.resolve("@agentclientprotocol/sdk/schema/v1/schema.json")),
      "utf8",
    ),
  );
  const validate = new Ajv2020({
    strict: false,
    validateFormats: false,
  }).compile({
    $defs: schema.$defs,
    $ref: "#/$defs/InitializeResponse",
  });
  const records = readFileSync("fixtures/antigravity/1.4.12/initialize-no-auth.jsonl", "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(records).toHaveLength(2);
  expect(records[0].message.method).toBe("initialize");
  const result = records[1].message.result;
  expect(validate(result), JSON.stringify(validate.errors)).toBe(true);
  expect(result.agentInfo.version).toBe("1.4.12");
  expect(result.agentCapabilities.loadSession).toBe(true);
  expect(result.agentCapabilities.mcpCapabilities.http).toBe(true);
});

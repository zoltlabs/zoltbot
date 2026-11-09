import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { type AgentDefinition, AgentDefinitionSchema, parse } from "@zoltbot/protocol";
import { parseCommand } from "./command.js";

let validator: Promise<(value: unknown) => boolean> | undefined;
function initializeResponse(value: unknown) {
  validator ??= Promise.all([
    import("ajv/dist/2020.js"),
    readFile(
      new URL(import.meta.resolve("@agentclientprotocol/sdk/schema/v1/schema.json")),
      "utf8",
    ),
  ]).then(([{ Ajv2020 }, text]) => {
    const schema = JSON.parse(text);
    return new Ajv2020({ strict: false, validateFormats: false }).compile({
      $defs: schema.$defs,
      $ref: "#/$defs/InitializeResponse",
    });
  });
  return validator.then((validate) => validate(value));
}
/** The host must enforce OS isolation, an empty cwd, no inherited credentials, and a ten second deadline. */
export interface ProbeSandbox {
  initialize(argv: string[]): Promise<unknown>;
}
export async function probeCommand(
  command: string,
  sandbox?: ProbeSandbox,
): Promise<{ definition?: AgentDefinition; error?: string }> {
  let argv: string[];
  try {
    argv = parseCommand(command);
  } catch {
    return { error: "invalid_command" };
  }
  if (!sandbox) return { error: "probe_sandbox_unavailable" };
  try {
    const response = await sandbox.initialize(argv);
    if (!(await initializeResponse(response))) return { error: "not_an_acp_agent" };
    const result = response as {
      protocolVersion: number;
      agentInfo?: { name: string; title?: string; version: string };
      agentCapabilities?: {
        loadSession?: boolean;
        promptCapabilities?: { image?: boolean };
        mcpCapabilities?: { http?: boolean };
      };
    };
    if (result.protocolVersion !== 1) return { error: "not_an_acp_agent" };
    const title = result.agentInfo?.title ?? result.agentInfo?.name ?? "Custom ACP agent";
    const definition = parse(AgentDefinitionSchema, {
      id: `custom-${randomUUID()}`,
      displayName: title.slice(0, 200),
      adapter: "acp",
      binaryNames: [argv[0]],
      versionCommand: ["--version"],
      launch: { command: argv[0], args: argv.slice(1), env: {} },
      testedVersions: "unverified",
      defaults: { permissionProfile: "workspace_write" },
      staticCapabilities: {
        resume: result.agentCapabilities?.loadSession ?? false,
        images: result.agentCapabilities?.promptCapabilities?.image ?? false,
        hostTools: result.agentCapabilities?.mcpCapabilities?.http ? "mcp_http" : "none",
      },
      nativeSessionRoots: [],
      experimental: false,
    });
    return { definition };
  } catch {
    return { error: "probe_failed" };
  }
}

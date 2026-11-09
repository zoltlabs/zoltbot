import type { AgentDefinition } from "@zoltbot/protocol";
import { Redactor } from "./logging.js";
import { isSecretReference } from "./secrets.js";

export function assertPublicDefinition(definition: AgentDefinition): void {
  let encoded: string;
  try {
    encoded = JSON.stringify(definition);
  } catch {
    throw new Error("invalid_definition");
  }
  if (
    ["[private argument]", "[private configuration]", "[redacted]"].some((marker) =>
      encoded.includes(JSON.stringify(marker)),
    )
  )
    throw new Error("definition_view_not_editable");
  const privateEnvironment = Object.entries(definition.launch.env).some(
    ([key, value]) =>
      value &&
      !isSecretReference(value) &&
      (key === definition.auth?.apiKeyEnv ||
        (/token|password|secret|authorization|api[_-]?key|credential/i.test(key) &&
          !/^(?:MAX_TOKENS|MAX_OUTPUT_TOKENS|MAX_INPUT_TOKENS|TOKEN_BUDGET|TOKEN_LIMIT|TOKEN_COUNT)$/i.test(
            key,
          ))),
  );
  const argumentsToCheck = [
    ...definition.launch.args,
    ...definition.versionCommand,
    ...(definition.auth?.statusCommand ?? []),
    ...(definition.auth?.loginCommand ?? []),
  ];
  const privateArgument = argumentsToCheck.some((argument) =>
    /^--?[\w-]*(?:api[-_]?key|token|password|secret|credential|authorization)(?:=|$)/i.test(
      argument,
    ),
  );
  if (
    privateEnvironment ||
    privateArgument ||
    new Redactor().text(encoded) !== encoded ||
    /[?&](?:access_token|api[_-]?key|token|password|secret|credential)=[^&\s"']+/i.test(encoded) ||
    /https?:\/\/[^/\s:@]+:[^/\s@]+@/i.test(encoded) ||
    /Authorization:\s*Basic\s+[^\s"']+/i.test(encoded)
  )
    throw new Error("definition_private_configuration_required");
}

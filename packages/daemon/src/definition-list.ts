import { createHash } from "node:crypto";
import { type AgentDefinition, AgentDefinitionSchema, parse } from "@zoltbot/protocol";
import { Redactor } from "./logging.js";
import { isSecretReference } from "./secrets.js";

/** Registry views are metadata, not executable configuration or a round trip editing payload. */
function publicDefinition(definition: AgentDefinition): AgentDefinition {
  const redactor = new Redactor();
  const view = redactor.value(definition);
  const hiddenArguments = (args: string[]) => args.map(() => "[private argument]");
  view.launch.args = hiddenArguments(definition.launch.args);
  view.versionCommand = hiddenArguments(definition.versionCommand);
  view.launch.env = Object.fromEntries(
    Object.entries(definition.launch.env).map(([key, value]) => [
      redactor.text(key),
      isSecretReference(value) ? value : "[private configuration]",
    ]),
  );
  if (view.auth) {
    if (definition.auth?.statusCommand)
      view.auth.statusCommand = hiddenArguments(definition.auth.statusCommand);
    if (definition.auth?.loginCommand)
      view.auth.loginCommand = hiddenArguments(definition.auth.loginCommand);
  }
  if (view.install) {
    if (view.install.command !== undefined) view.install.command = "[private configuration]";
    try {
      const url = new URL(view.install.docsUrl);
      view.install.docsUrl = ["https:", "http:"].includes(url.protocol)
        ? `${url.origin}${url.pathname}`
        : "[private configuration]";
    } catch {
      view.install.docsUrl = "[private configuration]";
    }
  }
  return parse(AgentDefinitionSchema, view);
}
export function listDefinitions(
  definitions: readonly AgentDefinition[],
  params: Record<string, unknown>,
): { items: AgentDefinition[]; cursor?: string } {
  const limit = params.limit ?? 50;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new Error("invalid_definition_page_size");
  const rows = definitions.map(publicDefinition).sort((a, b) => a.id.localeCompare(b.id));
  const stamp = createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 16);
  let offset = 0;
  if (params.cursor !== undefined) {
    const match = /^d1:(\d{1,9}):([a-f0-9]{16})$/.exec(String(params.cursor));
    if (!match || match[2] !== stamp || Number(match[1]) > rows.length)
      throw new Error("definition_cursor_stale");
    offset = Number(match[1]);
  }
  return {
    items: rows.slice(offset, offset + limit),
    ...(offset + limit < rows.length ? { cursor: `d1:${offset + limit}:${stamp}` } : {}),
  };
}

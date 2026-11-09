import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  type AgentDefinition,
  AgentDefinitionSchema,
  experimentalProvidersEnabled,
  parse,
} from "@zoltbot/protocol";
export interface DefinitionError {
  file: string;
  code:
    | "invalid_definition"
    | "credential_reference_required"
    | "unsafe_definition_file"
    | "duplicate_definition"
    | "definition_directory_unavailable";
}
export async function loadDefinitions(
  builtins: AgentDefinition[],
  dataDir: string,
  preference?: unknown,
) {
  const definitions = new Map(builtins.map((item) => [item.id, parseDefinition(item)]));
  const errors: DefinitionError[] = [];
  const overridden: string[] = [];
  const sourceFiles = new Map<string, string>();
  const duplicateIds: string[] = [];
  const directory = path.join(dataDir, "definitions");
  const info = await lstat(directory).catch(() => undefined);
  if (!info) return result();
  const base = await realpath(dataDir);
  const resolved = await realpath(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || !resolved.startsWith(`${base}${path.sep}`)) {
    errors.push({ file: "definitions", code: "unsafe_definition_file" });
    return result();
  }
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => {
    errors.push({ file: "definitions", code: "definition_directory_unavailable" });
    return [];
  });
  const pending = new Map<string, { definition: AgentDefinition; file: string }[]>();
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.endsWith(".json")) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) {
      errors.push({ file: entry.name, code: "unsafe_definition_file" });
      continue;
    }
    try {
      const file = path.join(directory, entry.name);
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 262144) throw new Error("invalid");
      const definition = parseDefinition(JSON.parse(await readFile(file, "utf8")));
      const group = pending.get(definition.id) ?? [];
      group.push({ definition, file: entry.name });
      pending.set(definition.id, group);
    } catch (error) {
      errors.push({
        file: entry.name,
        code:
          error instanceof Error && error.message === "credential_reference_required"
            ? "credential_reference_required"
            : "invalid_definition",
      });
    }
  }
  for (const group of pending.values()) {
    if (group.length > 1) {
      if (group[0]) duplicateIds.push(group[0].definition.id);
      for (const item of group) errors.push({ file: item.file, code: "duplicate_definition" });
    } else if (group[0]) {
      const { definition, file } = group[0];
      if (definitions.has(definition.id)) overridden.push(definition.id);
      definitions.set(definition.id, definition);
      sourceFiles.set(definition.id, file);
    }
  }
  return result();
  function result() {
    return {
      definitions: visible(),
      errors,
      overridden,
      sourceFiles: Object.fromEntries(sourceFiles),
      duplicateIds,
    };
  }
  function visible() {
    return [...definitions.values()].filter(
      (item) => !item.experimental || experimentalProvidersEnabled(preference),
    );
  }
}

export function parseDefinition(value: unknown): AgentDefinition {
  const definition = parse(AgentDefinitionSchema, value);
  if (!["claude", "codex", "acp", "pi"].includes(definition.adapter))
    throw new Error("invalid_definition");
  const credential =
    /(?:^|_)(?:API_?KEY|ACCESS_?KEY|KEY|SECRET|TOKEN|PASSWORD|AUTHORIZATION|COOKIE|CREDENTIALS?)(?:_|$)/i;
  for (const [name, value] of Object.entries(definition.launch.env)) {
    if (value && credential.test(name) && !/(?:_FILE|_PATH|_SOCK|_ENV|_NAME)$/i.test(name))
      throw new Error("credential_reference_required");
  }
  return definition;
}

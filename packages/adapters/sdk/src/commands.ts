import type { NativeCommand } from "@zoltbot/protocol";
/** Public metadata only; never carry extension paths or the private ready proof into UI state. */
export function nativeCommands(value: unknown): NativeCommand[] {
  if (!Array.isArray(value)) return [];
  const commands: NativeCommand[] = [],
    seen = new Set<string>();
  for (const raw of value) {
    const item = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const name = (
      typeof raw === "string" ? raw : typeof item.name === "string" ? item.name : ""
    ).replace(/^\/+/, "");
    if (
      !name ||
      name.length > 128 ||
      !/^[a-z0-9_][a-z0-9_:./-]*$/i.test(name) ||
      name === "zoltbot_ready" ||
      seen.has(name)
    )
      continue;
    seen.add(name);
    const input =
      item.input && typeof item.input === "object" ? (item.input as Record<string, unknown>) : {};
    const hint = typeof item.argumentHint === "string" ? item.argumentHint : input.hint;
    commands.push({
      name,
      ...(typeof item.description === "string" && item.description
        ? { description: item.description.slice(0, 2000) }
        : {}),
      ...(typeof hint === "string" && hint ? { argumentHint: hint.slice(0, 256) } : {}),
    });
    if (commands.length === 100) break;
  }
  return commands;
}

import { type ImportItem, ImportReceiptSchema, parse } from "@zoltbot/protocol";
import { type Command, type CommandContext, handle, type Outcome } from "./commands.js";
import { applyEvents, type DomainState } from "./projectors.js";

function entries(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item) => item && typeof item === "object" && !Array.isArray(item))
    : [];
}
export function importOutcome(
  initial: DomainState,
  input: unknown,
  context: CommandContext,
  confirmed: boolean,
): Outcome {
  if (!confirmed || context.actor.kind !== "human") throw new Error("import_consent_required");
  const receipt = parse(ImportReceiptSchema, input);
  if (new Set(receipt.items.map((item) => item.id)).size !== receipt.items.length)
    throw new Error("duplicate_import_item");
  let state = initial;
  const events: Outcome["events"] = [];
  const setting = (key: string) => entries(state.settings?.find((item) => item.key === key)?.value);
  const mcp = [...setting("mcp.registry")],
    pending = [...setting("imports.pending")];
  function command(value: Command) {
    const outcome = handle(state, value, {
      ...context,
      commandId: `${context.commandId}:step:${events.length}`,
    });
    events.push(...outcome.events);
    state = applyEvents(state, outcome.events);
  }
  function keepPending(item: ImportItem) {
    const identity = item.nativePath ?? item.path ?? item.name;
    if (
      !pending.some(
        (other) =>
          other.source === item.source &&
          (other.nativePath ?? other.path ?? other.name) === identity,
      )
    )
      pending.push(item);
  }
  for (const item of receipt.items) {
    if (item.kind === "project") {
      if (!item.path || !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(item.path)) {
        keepPending(item);
        continue;
      }
      const exists = state.project?.some((project) =>
        entries(project.roots).some((root) => root.path === item.path),
      );
      const repoRoot = item.repoRoot ?? (item.source === "git" ? item.path : undefined);
      if (!exists)
        command({
          type: "create",
          kind: "project",
          value: {
            id: `import:${item.id}`,
            name: item.name,
            goal: "",
            instructions: "",
            constraints: "",
            roots: [{ path: item.path, ...(repoRoot ? { repoRoot } : {}), label: item.name }],
            hierarchyDepth: 1,
            tags: [],
            requireCodeReview: true,
            skipFinalGateWhenReviewed: false,
            archived: false,
            createdAt: context.at,
          },
        });
    } else if (item.kind === "session") {
      if (!item.nativeId) {
        keepPending(item);
        continue;
      }
      if (
        !state.nativeSession?.some(
          (session) => session.provider === item.source && session.nativeId === item.nativeId,
        )
      )
        command({
          type: "create",
          kind: "nativeSession",
          value: {
            provider: item.source,
            nativeId: item.nativeId,
            title: item.name,
            source: "import",
            adopted: false,
            missing: false,
            lastSeenAt: context.at,
            ...(item.modifiedAt === undefined
              ? {}
              : { lastActivityAt: new Date(item.modifiedAt).toISOString() }),
          },
        });
    } else if (
      !mcp.some(
        (server) =>
          server.source === item.source &&
          server.name === item.name &&
          server.nativePath === item.nativePath &&
          server.scopePath === item.scopePath,
      )
    ) {
      mcp.push({
        id: `import:${item.id}`,
        name: item.name,
        source: item.source,
        ...(item.nativePath ? { nativePath: item.nativePath } : {}),
        ...(item.scopePath ? { scopePath: item.scopePath } : {}),
        configuration: item.configuration ?? {},
        state: "needs_confirmation",
        enabledAgentIds: [],
      });
    }
  }
  for (const [key, value] of [
    ["mcp.registry", mcp],
    ["imports.pending", pending],
  ] as const) {
    const previous = state.settings?.find((item) => item.key === key);
    if (JSON.stringify(previous?.value ?? []) === JSON.stringify(value)) continue;
    command(
      previous
        ? { type: "update", kind: "settings", id: key, changes: { value } }
        : { type: "create", kind: "settings", value: { key, value } },
    );
  }
  command({
    type: "create",
    kind: "audit",
    value: {
      id: `audit:${context.commandId}`,
      actor: context.actor,
      action: "import.apply",
      target: receipt.id,
      result: "allowed",
      detail: { selected: receipt.items.map((item) => item.id) },
      at: context.at,
    },
  });
  return {
    events: events.map((event, index) => ({
      ...event,
      eventId: `${context.commandId}:${index}`,
      commandId: context.commandId,
    })),
    result: {
      ok: true,
      previewId: receipt.id,
      selected: receipt.items.map((item) => item.id).sort(),
    },
  };
}

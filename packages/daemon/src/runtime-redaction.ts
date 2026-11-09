import { type AgentEvent, AgentEventSchema, type InteractionDraft, parse } from "@zoltbot/protocol";
import type { Redactor } from "./logging.js";
import { isTestCommand } from "./test-command.js";

/** Preserve schema field identities and constraints while masking descriptive content. */
function formSchema(value: unknown, redactor: Redactor): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return redactor.value(value);
  const metadata = new Set([
    "type",
    "required",
    "additionalProperties",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
  ]);
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (key === "properties" && entry && typeof entry === "object" && !Array.isArray(entry))
        return [
          key,
          Object.fromEntries(
            Object.entries(entry).map(([name, schema]) => [name, formSchema(schema, redactor)]),
          ),
        ];
      return [key, metadata.has(key) ? entry : redactor.value(entry)];
    }),
  );
}
function diff(
  value: { path: string; before?: string; after?: string; patch?: string },
  redactor: Redactor,
) {
  return {
    path: redactor.text(value.path),
    ...(value.before !== undefined ? { before: redactor.text(value.before) } : {}),
    ...(value.after !== undefined ? { after: redactor.text(value.after) } : {}),
    ...(value.patch !== undefined ? { patch: redactor.text(value.patch) } : {}),
  };
}
function interaction(request: InteractionDraft, redactor: Redactor): InteractionDraft {
  const text = (value: string) => redactor.text(value);
  const context = request.context;
  // A suggested rule is only offered when redaction leaves its matcher unchanged.
  const suggestion =
    context?.ruleSuggestion &&
    JSON.stringify(redactor.value(context.ruleSuggestion)) ===
      JSON.stringify(context.ruleSuggestion)
      ? context.ruleSuggestion
      : undefined;
  return {
    ...request,
    ...(request.title !== undefined ? { title: text(request.title) } : {}),
    items: request.items.map((item) => ({
      ...item,
      prompt: text(item.prompt),
      ...(item.default !== undefined
        ? {
            default: item.options?.some((option) => option.id === item.default)
              ? item.default
              : text(item.default),
          }
        : {}),
      ...(item.choices
        ? {
            choices: item.choices
              .filter(
                (choice) =>
                  !("rule" in choice) ||
                  JSON.stringify(redactor.value(choice.rule.matcher)) ===
                    JSON.stringify(choice.rule.matcher),
              )
              .map((choice) =>
                "label" in choice && choice.label !== undefined
                  ? { ...choice, label: text(choice.label) }
                  : choice,
              ),
          }
        : {}),
      ...(item.header !== undefined ? { header: text(item.header).slice(0, 12) } : {}),
      ...(item.schema !== undefined ? { schema: formSchema(item.schema, redactor) } : {}),
      ...(item.options
        ? {
            options: item.options.map((option) => ({
              ...option,
              label: text(option.label),
              ...(option.description !== undefined
                ? { description: text(option.description) }
                : {}),
            })),
          }
        : {}),
    })),
    ...(context
      ? {
          context: {
            ...(({ ruleSuggestion: _ignored, ...rest }) => rest)(context),
            ...(suggestion ? { ruleSuggestion: suggestion } : {}),
            ...(context.markdown !== undefined ? { markdown: text(context.markdown) } : {}),
            ...(context.toolName !== undefined ? { toolName: text(context.toolName) } : {}),
            ...(context.command !== undefined ? { command: text(context.command) } : {}),
            ...(context.cwd !== undefined ? { cwd: text(context.cwd) } : {}),
            ...(context.paths ? { paths: context.paths.map(text) } : {}),
            ...(context.toolInput !== undefined
              ? { toolInput: redactor.value(context.toolInput) }
              : {}),
            ...(context.diffs
              ? { diffs: context.diffs.map((value) => diff(value, redactor)) }
              : {}),
            ...(context.network
              ? { network: { ...context.network, host: text(context.network.host) } }
              : {}),
            ...(context.deliverable
              ? {
                  deliverable: {
                    ...context.deliverable,
                    summary: text(context.deliverable.summary),
                    checks: redactor.value(context.deliverable.checks),
                    ...(context.deliverable.previewRef !== undefined
                      ? { previewRef: text(context.deliverable.previewRef) }
                      : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
  };
}
/** Redact content, not protocol identities, capability enums, or usage counters. */
export function redactRuntimeEvent(input: AgentEvent, redactor: Redactor): AgentEvent {
  const event = structuredClone(parse(AgentEventSchema, input));
  switch (event.t) {
    case "session.ready":
    case "capabilities.updated":
      if (event.capabilities.slashCommands)
        event.capabilities.slashCommands = event.capabilities.slashCommands
          .filter((command) => redactor.text(command.name) === command.name)
          .map((command) => ({
            ...command,
            ...(command.description !== undefined
              ? { description: redactor.text(command.description).slice(0, 2000) }
              : {}),
            ...(command.argumentHint !== undefined
              ? { argumentHint: redactor.text(command.argumentHint).slice(0, 256) }
              : {}),
          }));
      break;
    case "text.delta":
    case "thought.delta":
    case "message.done":
    case "thought.done":
      event.text = redactor.text(event.text);
      break;
    case "tool.started":
      delete event.check;
      if (event.kind === "execute" && isTestCommand(event.input)) event.check = "tests";
      event.name = redactor.text(event.name);
      // A title summarizes the input (a command, path or URL), so it follows the input's privacy.
      if (redactor.hidesFrames) delete event.title;
      else if (event.title !== undefined) event.title = redactor.text(event.title);
      event.input = redactor.hidesFrames
        ? "[private tool input omitted]"
        : redactor.value(event.input);
      if (redactor.hidesFrames) delete event.locations;
      if (event.locations)
        event.locations = event.locations.map((location) => ({
          ...location,
          path: redactor.text(location.path),
        }));
      break;
    case "tool.updated":
    case "tool.done":
      if (redactor.hidesFrames) {
        event.output = "[private tool output omitted]";
        if (event.t === "tool.updated") delete event.content;
        if (event.t === "tool.done") delete event.diffs;
        break;
      }
      if (event.output !== undefined) event.output = redactor.value(event.output);
      if (event.t === "tool.updated" && event.content)
        event.content = redactor.value(event.content);
      if (event.t === "tool.done" && event.diffs)
        event.diffs = event.diffs.map((value) => diff(value, redactor));
      break;
    case "plan.updated":
      event.entries = event.entries.map((entry) => ({ ...entry, step: redactor.text(entry.step) }));
      break;
    case "interaction.requested":
      event.interaction = interaction(event.interaction, redactor);
      break;
    case "background.updated": {
      const task = { ...event.task };
      if (redactor.hidesFrames) {
        task.description = "[private background task]";
        delete task.summary;
        delete task.outputPath;
      } else {
        task.description = redactor.text(task.description);
        if (task.summary !== undefined) task.summary = redactor.text(task.summary);
        if (task.outputPath !== undefined) task.outputPath = redactor.text(task.outputPath);
      }
      event.task = task;
      break;
    }
    case "status":
      if (event.detail !== undefined) event.detail = redactor.text(event.detail);
      break;
    case "turn.done":
      if (event.stopReason !== undefined) event.stopReason = redactor.text(event.stopReason);
      if (event.error)
        event.error = {
          ...event.error,
          message: redactor.text(event.error.message),
          ...(event.error.fix !== undefined ? { fix: redactor.text(event.error.fix) } : {}),
        };
      break;
  }
  return parse(AgentEventSchema, event);
}

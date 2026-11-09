import type { InteractionAnswer, InteractionDraft } from "@zoltbot/protocol";
import { elicitationAnswer, elicitationInteraction } from "./elicitation.js";
import {
  type ClaudePolicy,
  fetchTarget,
  narrowPolicy,
  ruleSuggestion,
  sessionChoice,
  sessionGrants,
} from "./permissions.js";
import { editTools, toolDiffs } from "./tools.js";
import { record, string } from "./usage.js";

export { type ClaudePolicy, narrowPolicy } from "./permissions.js";

function questions(input: Record<string, unknown>) {
  if (!Array.isArray(input.questions) || !input.questions.length || input.questions.length > 4)
    throw new Error("provider_protocol_error");
  return input.questions.map(record);
}
const reviewerNotes = "\n\n## Reviewer notes\n";
export function claudeInteraction(
  request: Record<string, unknown>,
  ids: { id: string; agentId: string; threadId: string; turnId: string },
  planText?: string,
  policy: ClaudePolicy = narrowPolicy,
): InteractionDraft {
  const base = { ...ids, nativeRef: ids.id, chain: [], urgency: "blocking" as const };
  if (request.subtype === "elicitation") return elicitationInteraction(request, base);
  if (request.subtype !== "can_use_tool") throw new Error("unsupported_control_request");
  const tool = string(request.tool_name),
    input = record(request.input);
  if (tool === "AskUserQuestion")
    return {
      ...base,
      type: "question",
      context: { toolName: tool, toolInput: input },
      items: questions(input).map((q, index) => {
        const options = Array.isArray(q.options) ? q.options.map(record) : [];
        if (options.length > 8) throw new Error("provider_protocol_error");
        return {
          id: `q${index + 1}`,
          header: typeof q.header === "string" ? q.header.slice(0, 12) : "",
          prompt: string(q.question).slice(0, 2000),
          multi: q.multiSelect === true,
          allowOther: q.allowOther !== false,
          secret: q.secret === true || q.isSecret === true,
          options: options.map((o, i) => {
            const label = string(o.label);
            return {
              id: String(i),
              label: label.replace(/\s*\(Recommended\)\s*$/i, ""),
              ...(typeof o.description === "string" ? { description: o.description } : {}),
              recommended: /\(Recommended\)\s*$/i.test(label),
            };
          }),
        };
      }),
    };
  if (tool === "ExitPlanMode") {
    const markdown = typeof input.plan === "string" && input.plan ? input.plan : planText;
    if (!markdown) throw new Error("plan_content_unavailable");
    return {
      ...base,
      type: "plan",
      context: { markdown, toolName: tool, toolInput: input },
      items: [
        {
          id: "plan",
          prompt: "Approve this plan?",
          // Read only profiles never offer auto accepted edits.
          choices: [
            ...(policy.modes.includes("acceptEdits")
              ? [{ id: "allow_accept_edits" as const }]
              : []),
            { id: "allow_once" as const },
            { id: "reject_once" as const },
          ],
        },
      ],
    };
  }
  const grants = sessionGrants(request.permission_suggestions, policy),
    session = sessionChoice(request.permission_suggestions, policy),
    diffs = editTools.includes(tool) ? toolDiffs(tool, input) : undefined,
    target = tool === "WebFetch" ? fetchTarget(input.url) : undefined,
    suggestion = ruleSuggestion(tool, input, grants, policy.cwd),
    kind =
      tool === "Bash"
        ? ("execute" as const)
        : editTools.includes(tool)
          ? ("edit" as const)
          : target
            ? ("fetch" as const)
            : /^mcp__/.test(tool)
              ? ("other" as const)
              : undefined;
  const file =
    typeof input.file_path === "string"
      ? input.file_path
      : typeof input.notebook_path === "string"
        ? input.notebook_path
        : undefined;
  return {
    ...base,
    type: "approval",
    title: tool,
    context: {
      toolName: tool,
      ...(kind ? { toolKind: kind } : {}),
      toolInput: input,
      ...(typeof input.command === "string" ? { command: input.command } : {}),
      ...(typeof request.cwd === "string" ? { cwd: request.cwd } : {}),
      ...(file ? { paths: [file] } : {}),
      ...(target ? { network: target } : {}),
      ...(diffs ? { diffs } : {}),
      ...(suggestion ? { ruleSuggestion: suggestion } : {}),
    },
    items: [
      {
        id: "approval",
        prompt: `Allow ${tool}?`,
        choices: [
          { id: "allow_once" },
          ...(session ? [{ id: "allow_session" as const, label: session.label }] : []),
          { id: "reject_once" },
        ],
      },
    ],
  };
}
/** The native mode a plan answer switches to, so the session can report mode.changed. */
export function grantedMode(response: Record<string, unknown>) {
  if (!Array.isArray(response.updatedPermissions)) return undefined;
  const update = response.updatedPermissions
    .map(record)
    .findLast((value) => value.type === "setMode" && typeof value.mode === "string");
  return update?.mode as string | undefined;
}
export function claudeAnswer(
  request: Record<string, unknown>,
  answer: InteractionAnswer,
  policy: ClaudePolicy = narrowPolicy,
  planText?: string,
): Record<string, unknown> {
  if (request.subtype === "elicitation") return elicitationAnswer(request, answer);
  if (request.subtype !== "can_use_tool") throw new Error("unsupported_control_request");
  const deny = { behavior: "deny", message: answer.feedback ?? "Request declined." };
  if (answer.action !== "accept") return deny;
  const input = record(request.input);
  if (request.tool_name === "ExitPlanMode") {
    const accept = answer.choice === "allow_accept_edits";
    if (
      (answer.choice !== undefined && answer.choice !== "allow_once" && !accept) ||
      (accept && !policy.modes.includes("acceptEdits"))
    )
      return deny;
    const plan = typeof input.plan === "string" && input.plan ? input.plan : planText;
    // Accepting with feedback keeps the feedback: the tool result echoes the approved plan.
    const updatedInput =
      answer.feedback && plan
        ? { ...input, plan: `${plan}${reviewerNotes}${answer.feedback}` }
        : input;
    return {
      behavior: "allow",
      updatedInput,
      updatedPermissions: [
        { type: "setMode", mode: accept ? "acceptEdits" : policy.baseMode, destination: "session" },
      ],
    };
  }
  if (answer.choice === "allow_session") {
    const session = sessionChoice(request.permission_suggestions, policy);
    if (request.tool_name === "AskUserQuestion" || !session) return deny;
    return { behavior: "allow", updatedInput: input, updatedPermissions: session.grants };
  }
  if (answer.choice !== undefined && answer.choice !== "allow_once") return deny;
  if (request.tool_name !== "AskUserQuestion") return { behavior: "allow", updatedInput: input };
  const grouped = new Map<string, { index: number; value: string }[]>();
  questions(input).forEach((q, index) => {
    const resolution = answer.answers?.[`q${index + 1}`];
    const options = Array.isArray(q.options) ? q.options.map(record) : [];
    const values = (resolution?.options ?? []).map((id) => {
      if (!/^(?:0|[1-9]\d*)$/.test(id) || !options[Number(id)])
        throw new Error("invalid_question_answer");
      return string(options[Number(id)]?.label);
    });
    if (resolution?.other !== undefined) {
      if (q.allowOther === false) throw new Error("invalid_question_answer");
      values.push(resolution.other);
    }
    // Secret items are answered as {value} so the text stays out of display fields.
    if (resolution?.value !== undefined) {
      if (typeof resolution.value !== "string") throw new Error("invalid_question_answer");
      values.push(resolution.value);
    }
    const key = string(q.question),
      previous = grouped.get(key) ?? [];
    grouped.set(key, [...previous, { index: index + 1, value: values.join(", ") }]);
  });
  const answers = Object.fromEntries(
    [...grouped].map(([key, values]) => [
      key,
      values.length === 1
        ? (values[0]?.value ?? "")
        : values.map((v) => `[${v.index}] ${v.value}`).join("\n"),
    ]),
  );
  return { behavior: "allow", updatedInput: { ...input, answers } };
}

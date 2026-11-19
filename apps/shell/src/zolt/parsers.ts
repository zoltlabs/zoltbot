import {
  type BrowserBounds,
  type BrowserOpenInput,
  type BrowserVisibilityInput,
  type CancelQueuedMessageInput,
  type DecidePlanInput,
  type ImportAttachmentsInput,
  type InterruptTurnInput,
  isAgentModel,
  isAvatarColor,
  isAvatarShape,
  isMessageReaction,
  isReasoningEffort,
  type MacPermissionId,
  type OpenAttachmentInput,
  type RespondToPromptInput,
  type SendMessageInput,
  type SetQueuePausedInput,
  type UpdateBotInput,
} from "../shared/ipc";
import {
  type ReviewTaskInput,
  TASK_REVIEW_DECISIONS,
  type TaskReviewDecision,
} from "../shared/tasks";

/** Checks every value the renderer sends before main acts on it. */
export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
  return value;
}

export function parseSendMessage(value: unknown): SendMessageInput {
  if (!isObject(value)) throw new Error("Invalid send message request.");
  const attachmentDraftIds = value.attachmentDraftIds ?? [];
  if (
    !Array.isArray(attachmentDraftIds) ||
    !attachmentDraftIds.every((item) => typeof item === "string")
  ) {
    throw new Error("Invalid attachment drafts.");
  }
  if (typeof value.text !== "string") throw new Error("text is required.");
  if (!value.text.trim() && attachmentDraftIds.length === 0) {
    throw new Error("A message or attachment is required.");
  }
  const replyToMessageId = value.replyToMessageId ?? null;
  if (replyToMessageId !== null && typeof replyToMessageId !== "string") {
    throw new Error("Invalid reply target.");
  }
  return {
    botId: requireString(value.botId, "botId"),
    text: value.text,
    attachmentDraftIds,
    replyToMessageId: replyToMessageId?.trim() || null,
  };
}

export function parseDecidePlan(value: unknown): DecidePlanInput {
  if (!isObject(value)) throw new Error("Invalid plan decision.");
  if (typeof value.approve !== "boolean") throw new Error("approve is required.");
  if (!Number.isInteger(value.version) || Number(value.version) < 1)
    throw new Error("version is required.");
  return {
    projectId: requireString(value.projectId, "projectId"),
    planId: requireString(value.planId, "planId"),
    version: Number(value.version),
    approve: value.approve,
  };
}

export function parseReviewTask(value: unknown): ReviewTaskInput {
  if (!isObject(value)) throw new Error("Invalid task review.");
  if (!TASK_REVIEW_DECISIONS.includes(value.decision as TaskReviewDecision))
    throw new Error("decision is required.");
  if (!Number.isInteger(value.revision) || Number(value.revision) < 1)
    throw new Error("revision is required.");
  const feedback = typeof value.feedback === "string" ? value.feedback.trim() : "";
  if (value.decision === "changes" && !feedback) throw new Error("Say what to change.");
  if (feedback.length > 2000) throw new Error("Keep the feedback under 2,000 characters.");
  return {
    taskId: requireString(value.taskId, "taskId"),
    revision: Number(value.revision),
    decision: value.decision as TaskReviewDecision,
    ...(value.decision === "changes" ? { feedback } : {}),
  };
}

export function parseMessageReaction(value: unknown) {
  if (!isObject(value)) throw new Error("Invalid message reaction request.");
  const emoji = value.emoji;
  if (emoji !== null && !isMessageReaction(emoji)) {
    throw new Error("Invalid message reaction.");
  }
  return {
    botId: requireString(value.botId, "botId"),
    messageId: requireString(value.messageId, "messageId"),
    emoji,
  };
}

export function parseUpdateBot(value: unknown): UpdateBotInput {
  if (!isObject(value)) throw new Error("Invalid bot update request.");
  const result: UpdateBotInput = { botId: requireString(value.botId, "botId") };
  for (const field of ["name", "role", "description"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw new Error(`Invalid ${field}.`);
    }
    if (typeof value[field] === "string") result[field] = value[field];
  }
  if (value.notifications !== undefined) {
    if (typeof value.notifications !== "boolean") throw new Error("Invalid notifications value.");
    result.notifications = value.notifications;
  }
  if (value.model !== undefined) {
    if (!isAgentModel(value.model)) throw new Error("Invalid agent model.");
    result.model = value.model;
  }
  if (value.reasoningEffort !== undefined) {
    if (!isReasoningEffort(value.reasoningEffort)) throw new Error("Invalid reasoning effort.");
    result.reasoningEffort = value.reasoningEffort;
  }
  if (value.avatarShape !== undefined) {
    if (!isAvatarShape(value.avatarShape)) throw new Error("Invalid avatar shape.");
    result.avatarShape = value.avatarShape;
  }
  if (value.avatarColor !== undefined) {
    if (!isAvatarColor(value.avatarColor)) throw new Error("Invalid avatar color.");
    result.avatarColor = value.avatarColor;
  }
  return result;
}

export function parseImportAttachments(value: unknown): ImportAttachmentsInput {
  if (!isObject(value) || !Array.isArray(value.paths) || !Array.isArray(value.data)) {
    throw new Error("Invalid attachment import.");
  }
  if (!value.paths.every((path) => typeof path === "string" && path.length > 0)) {
    throw new Error("Invalid attachment path.");
  }
  const data = value.data.map((item) => {
    if (
      !isObject(item) ||
      typeof item.name !== "string" ||
      typeof item.mimeType !== "string" ||
      !(item.bytes instanceof Uint8Array)
    ) {
      throw new Error("Invalid attachment data.");
    }
    return { name: item.name, mimeType: item.mimeType, bytes: item.bytes };
  });
  return { paths: value.paths, data };
}

export function parseOpenAttachment(value: unknown): OpenAttachmentInput {
  if (!isObject(value) || (value.action !== "open" && value.action !== "reveal")) {
    throw new Error("Invalid attachment action.");
  }
  return {
    attachmentId: requireString(value.attachmentId, "attachmentId"),
    action: value.action,
  };
}

export function parseCancelQueuedMessage(value: unknown): CancelQueuedMessageInput {
  if (!isObject(value)) throw new Error("Invalid queue cancellation request.");
  return {
    botId: requireString(value.botId, "botId"),
    deliveryId: requireString(value.deliveryId, "deliveryId"),
  };
}

export function parseSetQueuePaused(value: unknown): SetQueuePausedInput {
  if (!isObject(value) || typeof value.paused !== "boolean") {
    throw new Error("Invalid queue pause request.");
  }
  return { botId: requireString(value.botId, "botId"), paused: value.paused };
}

export function parseInterrupt(value: unknown): InterruptTurnInput {
  if (!isObject(value)) throw new Error("Invalid interrupt request.");
  return {
    botId: requireString(value.botId, "botId"),
    turnId: requireString(value.turnId, "turnId"),
  };
}

export function parsePromptResponse(value: unknown): RespondToPromptInput {
  if (
    !isObject(value) ||
    (typeof value.requestId !== "string" && typeof value.requestId !== "number")
  ) {
    throw new Error("Invalid prompt response.");
  }
  if (!isObject(value.answers)) throw new Error("Prompt answers are required.");
  const answers: Record<string, string[]> = {};
  for (const [key, answer] of Object.entries(value.answers)) {
    if (!Array.isArray(answer) || !answer.every((item) => typeof item === "string")) {
      throw new Error("Invalid prompt answer.");
    }
    answers[key] = answer;
  }
  return { requestId: value.requestId, answers };
}

export function parseBrowserOpen(value: unknown): BrowserOpenInput {
  if (!isObject(value)) throw new Error("Invalid browser open request.");
  return {
    url: requireString(value.url, "url"),
    ownerThreadId:
      value.ownerThreadId === null || value.ownerThreadId === undefined
        ? null
        : requireString(value.ownerThreadId, "ownerThreadId"),
    ownerBotId:
      value.ownerBotId === null || value.ownerBotId === undefined
        ? null
        : requireString(value.ownerBotId, "ownerBotId"),
  };
}

export function parseVisibility(value: unknown): BrowserVisibilityInput {
  if (!isObject(value) || typeof value.visible !== "boolean") {
    throw new Error("Invalid browser visibility request.");
  }
  return {
    visible: value.visible,
    bounds: value.bounds === undefined ? undefined : parseBounds(value.bounds),
  };
}

export function parseBounds(value: unknown): BrowserBounds {
  if (!isObject(value)) throw new Error("Invalid browser bounds.");
  const fields = ["x", "y", "width", "height"] as const;
  for (const field of fields) {
    if (typeof value[field] !== "number" || !Number.isFinite(value[field])) {
      throw new Error(`Invalid browser bound: ${field}.`);
    }
  }
  return {
    x: value.x as number,
    y: value.y as number,
    width: value.width as number,
    height: value.height as number,
  };
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseMacPermission(input: unknown): MacPermissionId {
  if (input !== "screen-recording" && input !== "accessibility") {
    throw new Error("Unknown macOS permission.");
  }
  return input;
}

export function parseCreateBot(input: unknown): { projectId?: string } {
  if (input === undefined || input === null) return {};
  if (!isObject(input)) throw new Error("Chat details are invalid.");
  if (input.projectId === undefined || input.projectId === null) return {};
  return { projectId: requireString(input.projectId, "projectId") };
}

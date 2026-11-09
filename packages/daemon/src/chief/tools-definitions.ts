// Nonsecret host tool schemas. Authorization remains in the handlers.
const key = { type: "string", minLength: 1, maxLength: 100 } as const;
const chatId = { type: "string", minLength: 1, maxLength: 256 } as const;
export const chiefToolDefinitions = [
  {
    name: "chief_overview",
    description:
      "List workspaces, teams and chats with status (needs_you, working, failed, done, idle) and your notes. Filter by workspaceId, status or a title query.",
    inputSchema: {
      type: "object" as const,
      properties: {
        workspaceId: { type: "string", maxLength: 256 },
        status: { type: "string", enum: ["needs_you", "working", "failed", "done", "idle"] },
        query: { type: "string", maxLength: 100 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "chief_read_chat",
    description: "Read a chat's status, what it is waiting on, and its recent output.",
    inputSchema: {
      type: "object" as const,
      properties: { chatId },
      required: ["chatId"],
      additionalProperties: false,
    },
  },
  {
    name: "chief_note",
    description:
      "Set the one-line note the user sees for a chat on the Overview, or your overall summary when chatId is omitted. Empty text clears it.",
    inputSchema: {
      type: "object" as const,
      properties: { chatId, text: { type: "string", maxLength: 280 } },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "chief_start_chat",
    description:
      "Ask the user to approve starting a chat in a workspace or team (workspaceId) with a self-contained brief. Optional profileId. Stable key.",
    inputSchema: {
      type: "object" as const,
      properties: {
        key,
        workspaceId: { type: "string", minLength: 1, maxLength: 256 },
        title: { type: "string", minLength: 1, maxLength: 150 },
        brief: { type: "string", minLength: 1, maxLength: 4000 },
        profileId: { type: "string", maxLength: 256 },
      },
      required: ["key", "workspaceId", "title", "brief"],
      additionalProperties: false,
    },
  },
  {
    name: "chief_message_chat",
    description:
      "Ask the user to approve sending a message to a chat; it wakes the chat. Stable key.",
    inputSchema: {
      type: "object" as const,
      properties: { key, chatId, text: { type: "string", minLength: 1, maxLength: 4000 } },
      required: ["key", "chatId", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "chief_stop_chat",
    description: "Ask the user to approve stopping a chat's running turn.",
    inputSchema: {
      type: "object" as const,
      properties: { chatId },
      required: ["chatId"],
      additionalProperties: false,
    },
  },
  {
    name: "chief_triage",
    description:
      "Order Needs you items: rank now, today or later, a one-line why, and your recommendation (approve, decline, or answer with an option id or drafted text). Answers nothing.",
    inputSchema: {
      type: "object" as const,
      properties: {
        items: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              interactionId: chatId,
              rank: { type: "string", enum: ["now", "today", "later"] },
              why: { type: "string", minLength: 1, maxLength: 200 },
              recommend: { type: "string", enum: ["approve", "decline", "answer"] },
              choice: { type: "string", maxLength: 256 },
              draft: { type: "string", maxLength: 2000 },
            },
            required: ["interactionId", "rank", "why"],
            additionalProperties: false,
          },
        },
      },
      required: ["items"],
      additionalProperties: false,
    },
  },
  {
    name: "chief_answer",
    description:
      "Only for decisions the user just stated to you. Prepare their answers to Needs you items as one confirmation card; text is sent word for word.",
    inputSchema: {
      type: "object" as const,
      properties: {
        key,
        items: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              interactionId: chatId,
              decision: { type: "string", enum: ["approve", "decline", "answer"] },
              choice: { type: "string", maxLength: 256 },
              text: { type: "string", maxLength: 2000 },
            },
            required: ["interactionId", "decision"],
            additionalProperties: false,
          },
        },
      },
      required: ["key", "items"],
      additionalProperties: false,
    },
  },
  {
    name: "chief_idea",
    description:
      "promote: put one idea in the user's queue (merge lead ideas by ids, or none for your own; title, why, stable key). drop: clear inbox entries by ids.",
    inputSchema: {
      type: "object" as const,
      properties: {
        op: { type: "string", enum: ["promote", "drop"] },
        ids: { type: "array", maxItems: 10, items: chatId },
        key,
        title: { type: "string", minLength: 1, maxLength: 150 },
        why: { type: "string", minLength: 1, maxLength: 400 },
      },
      required: ["op"],
      additionalProperties: false,
    },
  },
  {
    name: "chief_learn",
    description:
      "Propose one preference from a pattern of the user's overrules, citing those item ids. The user approves it in Knowledge review before it applies anywhere.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string", minLength: 1, maxLength: 120 },
        body: { type: "string", minLength: 1, maxLength: 600 },
        evidence: { type: "array", minItems: 1, maxItems: 10, items: chatId },
      },
      required: ["title", "body", "evidence"],
      additionalProperties: false,
    },
  },
];
export const chiefToolNames = new Set(chiefToolDefinitions.map((tool) => tool.name));

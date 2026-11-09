import { checkFlatForm, type InteractionAnswer, type InteractionDraft } from "@zoltbot/protocol";

type Value = Record<string, unknown>;
const consentSchema = { type: "object", properties: {} };
const message = (request: Value) =>
  typeof request.message === "string" && request.message.trim()
    ? request.message
    : "An MCP server requests input.";
function url(request: Value) {
  if (typeof request.url !== "string") return undefined;
  try {
    const parsed = new URL(request.url);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}
function formSchema(request: Value) {
  const schema = request.requested_schema;
  if (!schema || typeof schema !== "object" || (schema as Value).type !== "object")
    throw new Error("unsupported_elicitation");
  // Throws for nested objects, arrays, and other constraints the form card cannot render.
  checkFlatForm(schema, undefined);
  return schema;
}

/**
 * Claude control_request subtype "elicitation" from an MCP server. Form mode with a flat object
 * schema becomes a form interaction; URL mode becomes a consent form whose markdown shows the URL.
 * Anything else throws, and the session declines it (fail closed).
 */
export function elicitationInteraction(
  request: Value,
  base: Omit<InteractionDraft, "type" | "items">,
): InteractionDraft {
  const text = message(request),
    server = typeof request.mcp_server_name === "string" ? request.mcp_server_name : undefined;
  const prompt = text.slice(0, 2000),
    title = (server ? `${server}: ${text}` : text).slice(0, 200);
  if (request.mode === "url") {
    const link = url(request);
    if (!link) throw new Error("unsupported_elicitation");
    return {
      ...base,
      type: "form",
      title,
      context: { markdown: `${text}\n\nOpen this link to continue:\n\n<${link}>` },
      items: [{ id: "form", prompt, schema: consentSchema }],
    };
  }
  if (request.mode !== undefined && request.mode !== "form")
    throw new Error("unsupported_elicitation");
  return {
    ...base,
    type: "form",
    title,
    items: [{ id: "form", prompt, schema: formSchema(request) }],
  };
}
export function elicitationAnswer(request: Value, answer: InteractionAnswer) {
  if (answer.action === "decline") return { action: "decline" };
  if (answer.action !== "accept") return { action: "cancel" };
  if (request.mode === "url") return { action: "accept" };
  const content = answer.answers?.form?.value;
  if (!checkFlatForm(formSchema(request), content)) throw new Error("invalid_form_answer");
  return { action: "accept", content };
}
export const declined = { action: "decline" };

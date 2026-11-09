import { CreateElicitationRequest, type CreateElicitationResponse } from "@agentclientprotocol/sdk";
import type { InteractionAnswer, InteractionDraft } from "@zoltbot/protocol";
import { Ajv } from "ajv";

export function elicitationForm(
  request: CreateElicitationRequest,
  ids: { id: string; agentId: string; threadId: string; turnId: string },
): InteractionDraft | undefined {
  if (!CreateElicitationRequest.isForm(request)) return undefined;
  return {
    ...ids,
    type: "form",
    title: request.message,
    items: [{ id: "form", prompt: request.message, schema: request.requestedSchema }],
    chain: [],
    urgency: "blocking",
    nativeRef: ids.id,
  };
}
export function elicitationResponse(
  request: CreateElicitationRequest,
  answer: InteractionAnswer | undefined,
): CreateElicitationResponse {
  if (
    !answer ||
    answer.action === "cancel" ||
    answer.action === "expire" ||
    answer.action === "timeout"
  )
    return { action: "cancel" };
  if (answer.action === "decline") return { action: "decline" };
  if (!CreateElicitationRequest.isForm(request)) return { action: "cancel" };
  const content = answer.answers?.form?.value;
  const validate = new Ajv({ strict: false, validateFormats: false }).compile(
    request.requestedSchema,
  );
  if (!validate(content)) throw new Error("invalid_form_answer");
  return { action: "accept", content };
}

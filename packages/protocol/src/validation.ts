import type { TSchema } from "@sinclair/typebox";
import {
  type DomainEvent,
  DomainEventSchema,
  eventCatalog,
  methodCatalog,
  RpcRequestSchema,
} from "./catalog.js";
import { type CommandActor, CommandActorSchema, localCommandActor } from "./cloud.js";
import { parse } from "./common.js";

export function parseEvent(input: unknown): DomainEvent {
  const event = parse(DomainEventSchema, input);
  const schema = eventCatalog[event.type];
  if (!schema) throw new Error(`Uncatalogued event: ${event.type}`);
  parse(schema, event.payload);
  return event;
}
export function parseRequest(input: unknown, actor: CommandActor = localCommandActor()) {
  const request = parse(RpcRequestSchema, input);
  const contract = (methodCatalog as Record<string, { params: TSchema; result: TSchema }>)[
    request.method
  ];
  if (!contract) throw new Error(`Uncatalogued method: ${request.method}`);
  parse(contract.params, request.params);
  return {
    ...request,
    actor: parse(CommandActorSchema, actor),
    method: request.method as keyof typeof methodCatalog,
  };
}

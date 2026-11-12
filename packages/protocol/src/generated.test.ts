import { readFileSync } from "node:fs";
import type { TSchema } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import {
  agentEventSchemas,
  entitySchemas,
  eventCatalog,
  methodCatalog,
  parse,
  protocolVersion,
  RpcRequestSchema,
} from "./index.js";

function sample(schema: TSchema): unknown {
  if (schema.examples?.length) return structuredClone(schema.examples[0]);
  if ("const" in schema) return schema.const;
  if (schema.anyOf) return sample(schema.anyOf[0]);
  if (schema.type === "object")
    return Object.fromEntries(
      Object.entries(schema.properties ?? {})
        .filter(([k]) => schema.required?.includes(k))
        .map(([k, s]) => [k, sample(s as TSchema)]),
    );
  if (schema.type === "array")
    return Array.from({ length: schema.minItems ?? 0 }, () => sample(schema.items));
  if (schema.type === "integer" || schema.type === "number") return schema.minimum ?? 1;
  if (schema.type === "boolean") return false;
  if (schema.type === "string") {
    const value = [
      "example",
      "2026-10-27T12:00:00.000Z",
      "example/project",
      "a".repeat(40),
      "a".repeat(64),
    ].find(
      (candidate) =>
        (!schema.pattern || new RegExp(schema.pattern).test(candidate)) &&
        candidate.length >= (schema.minLength ?? 0) &&
        candidate.length <= (schema.maxLength ?? Number.MAX_SAFE_INTEGER),
    );
    if (value === undefined)
      throw new Error(`Add a canonical string fixture for ${schema.pattern ?? "string"}`);
    return value;
  }
  return {};
}

describe("generated schema contracts", () => {
  for (const [name, catalog] of Object.entries({
    entities: entitySchemas,
    methods: methodCatalog,
    events: eventCatalog,
    adapterEvents: agentEventSchemas,
    requests: { rpc: RpcRequestSchema },
  })) {
    it(`${name} JSON schema matches its TypeBox source`, () => {
      const generated = JSON.parse(
        readFileSync(new URL(`../schema/${name}.json`, import.meta.url), "utf8"),
      );
      expect(generated).toEqual(JSON.parse(JSON.stringify({ protocolVersion, schemas: catalog })));
    });
  }
  for (const [name, schema] of Object.entries(entitySchemas)) {
    it(`${name} round trips a canonical entity fixture`, () => {
      const value = sample(schema);
      expect(parse(schema, JSON.parse(JSON.stringify(value)))).toEqual(value);
    });
  }
  for (const [method, contract] of Object.entries(methodCatalog)) {
    it(`${method} accepts its canonical parameters and rejects wrong types`, () => {
      const value = sample(contract.params);
      expect(parse(contract.params, JSON.parse(JSON.stringify(value)))).toEqual(value);
      expect(() => parse(contract.params, [])).toThrow(/Invalid payload/);
    });
  }
});

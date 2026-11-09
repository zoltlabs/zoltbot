type Rule = (value: unknown) => boolean;
function unsupported(): never {
  throw new Error("unsupported_form_schema");
}
function record(value: unknown): value is Record<string, unknown> {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
function keys(schema: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(schema).some((key) => !allowed.includes(key))) unsupported();
  for (const key of ["title", "description"])
    if (schema[key] !== undefined && typeof schema[key] !== "string") unsupported();
}
function primitive(schema: unknown): Rule {
  if (!record(schema)) unsupported();
  keys(schema, [
    "type",
    "title",
    "description",
    "default",
    "enum",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
  ]);
  const type = schema.type;
  if (
    type !== undefined &&
    (typeof type !== "string" || !["string", "number", "integer", "boolean"].includes(type))
  )
    unsupported();
  if (type === undefined && schema.enum === undefined) unsupported();
  const choices = schema.enum;
  if (
    choices !== undefined &&
    (!Array.isArray(choices) ||
      !choices.length ||
      choices.length > 1000 ||
      choices.some(
        (value) => value !== null && !["string", "number", "boolean"].includes(typeof value),
      ))
  )
    unsupported();
  for (const key of ["minLength", "maxLength"])
    if (
      schema[key] !== undefined &&
      (type !== "string" ||
        typeof schema[key] !== "number" ||
        !Number.isInteger(schema[key]) ||
        Number(schema[key]) < 0)
    )
      unsupported();
  for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"])
    if (
      schema[key] !== undefined &&
      (!["number", "integer"].includes(String(type)) ||
        typeof schema[key] !== "number" ||
        !Number.isFinite(schema[key]))
    )
      unsupported();
  return (value) => {
    if (type === "string") {
      if (typeof value !== "string") return false;
      const length = Array.from(value).length;
      if (schema.minLength !== undefined && length < Number(schema.minLength)) return false;
      if (schema.maxLength !== undefined && length > Number(schema.maxLength)) return false;
    } else if (type === "number" || type === "integer") {
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        (type === "integer" && !Number.isInteger(value))
      )
        return false;
      if (schema.minimum !== undefined && value < Number(schema.minimum)) return false;
      if (schema.maximum !== undefined && value > Number(schema.maximum)) return false;
      if (schema.exclusiveMinimum !== undefined && value <= Number(schema.exclusiveMinimum))
        return false;
      if (schema.exclusiveMaximum !== undefined && value >= Number(schema.exclusiveMaximum))
        return false;
    } else if (type === "boolean" && typeof value !== "boolean") return false;
    return choices === undefined || (choices as unknown[]).some((choice) => choice === value);
  };
}
/** Supported form subset only. No coercion, defaults, remote references, or executable patterns. */
export function checkFlatForm(schema: unknown, value: unknown): boolean {
  if (!record(schema)) unsupported();
  if (schema.type !== "object") return primitive(schema)(value);
  keys(schema, [
    "type",
    "title",
    "description",
    "default",
    "properties",
    "required",
    "additionalProperties",
  ]);
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false)
    unsupported();
  const properties = schema.properties ?? {};
  if (!record(properties) || Object.keys(properties).length > 100) unsupported();
  const required = schema.required ?? [];
  if (
    !Array.isArray(required) ||
    required.some((key) => typeof key !== "string" || !Object.hasOwn(properties, key)) ||
    new Set(required).size !== required.length
  )
    unsupported();
  const rules = new Map(
    Object.entries(properties).map(([key, definition]) => [key, primitive(definition)]),
  );
  if (!record(value) || required.some((key) => !Object.hasOwn(value, key))) return false;
  return Object.entries(value).every(([key, input]) => rules.get(key)?.(input) === true);
}

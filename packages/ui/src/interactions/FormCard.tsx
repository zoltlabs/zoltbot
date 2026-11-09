import { checkFlatForm, type Interaction } from "@zoltbot/protocol";
import { useId, useState } from "react";
import type { AnswerDraft } from "./actions.js";
import { formHost, formLinks, linkOnlyForm } from "./request-data.js";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
function fields(schema: Record<string, unknown>) {
  return schema.type === "object"
    ? Object.entries(record(schema.properties)).map(([id, value]) => ({
        id,
        schema: record(value),
      }))
    : [{ id: "$", schema }];
}
function defaults(schema: Record<string, unknown>): unknown {
  if (schema.default !== undefined && checkFlatForm(schema, schema.default)) return schema.default;
  if (schema.type !== "object") return undefined;
  return Object.fromEntries(
    fields(schema).flatMap((field) =>
      field.schema.default !== undefined && checkFlatForm(field.schema, field.schema.default)
        ? [[field.id, field.schema.default]]
        : [],
    ),
  );
}
function LinkForm({
  request,
  disabled,
  submit,
  decline,
}: {
  request: Interaction;
  disabled: boolean;
  submit(answer: AnswerDraft): Promise<void>;
  decline(): void;
}) {
  const links = formLinks(request);
  const shown = request.context?.markdown ?? "";
  return (
    <div className="interaction-link-form">
      {request.items.map((item) => (
        <p className="interaction-prompt" key={item.id}>
          {item.prompt}
        </p>
      ))}
      {links.length ? (
        <ul className="interaction-links">
          {links.map((href) => (
            <li key={href}>
              <button
                type="button"
                className="btn pri"
                disabled={disabled}
                title={href}
                onClick={() => void window.zoltDesktop?.openExternal?.(href).catch(() => {})}
              >
                Open link
              </button>
              {/* The address shows once: in the request text, or here when the text omits it. */}
              {shown.includes(href) ? null : (
                <code className="interaction-url-chip truncate">{formHost(href)}</code>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="sm dim">
        {links.length
          ? "Finish in your browser, then accept so your coding tool continues."
          : "Accept to let your coding tool continue."}
      </p>
      <div className="interaction-buttons">
        <button
          type="button"
          className={`btn${links.length ? "" : " pri"}`}
          disabled={disabled}
          onClick={() =>
            void submit({
              action: "accept",
              answers: Object.fromEntries(request.items.map((item) => [item.id, { value: {} }])),
            })
          }
        >
          Accept
        </button>
        <button type="button" className="btn" disabled={disabled} onClick={decline}>
          Decline
        </button>
      </div>
    </div>
  );
}
export function FormCard({
  request,
  disabled,
  submit,
  decline,
}: {
  request: Interaction;
  disabled: boolean;
  submit(answer: AnswerDraft): Promise<void>;
  decline(): void;
}) {
  const prefix = useId();
  const linkOnly = linkOnlyForm(request);
  const supported = request.items.every((item) => {
    try {
      checkFlatForm(item.schema, undefined);
      return true;
    } catch {
      return false;
    }
  });
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(
      request.items.map((item) => {
        try {
          return [item.id, defaults(record(item.schema))];
        } catch {
          return [item.id, undefined];
        }
      }),
    ),
  );
  const [touched, setTouched] = useState(false);
  if (linkOnly)
    return <LinkForm request={request} disabled={disabled} submit={submit} decline={decline} />;
  if (!supported)
    return (
      <>
        <p>
          This form uses unsupported constraints. Decline or cancel it to let your coding tool
          continue safely.
        </p>
        <div className="interaction-buttons">
          <button type="button" className="btn" disabled={disabled} onClick={decline}>
            Decline
          </button>
        </div>
      </>
    );
  const valid = request.items.every((item) => checkFlatForm(item.schema, values[item.id]));
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && !disabled)
          void submit({
            action: "accept",
            answers: Object.fromEntries(
              request.items.map((item) => [item.id, { value: values[item.id] }]),
            ),
          });
      }}
    >
      {request.items.map((item) => {
        const schema = record(item.schema),
          required = Array.isArray(schema.required) ? schema.required : [];
        return (
          <fieldset key={item.id} disabled={disabled}>
            <legend>{item.prompt}</legend>
            {fields(schema).map((field) => {
              const object = schema.type === "object",
                current = object ? record(values[item.id])[field.id] : values[item.id];
              const label =
                typeof field.schema.title === "string"
                  ? field.schema.title
                  : object
                    ? field.id
                    : "Value";
              const options = Array.isArray(field.schema.enum) ? field.schema.enum : undefined;
              const update = (value: unknown) => {
                setTouched(true);
                setValues((previous) => {
                  const fields = { ...record(previous[item.id]), [field.id]: value };
                  if (value === undefined) delete fields[field.id];
                  return { ...previous, [item.id]: object ? fields : value };
                });
              };
              const controlId = `${prefix}-${encodeURIComponent(JSON.stringify([item.id, field.id]))}`;
              return (
                <label key={field.id} className="interaction-other" htmlFor={controlId}>
                  {label}
                  {!object || required.includes(field.id) ? " (required)" : ""}
                  {options ? (
                    <select
                      id={controlId}
                      value={options.findIndex((option) => Object.is(option, current))}
                      onChange={(event) => update(options[Number(event.target.value)])}
                    >
                      <option value={-1}>Choose a value</option>
                      {options.map((option, index) => (
                        <option key={`${typeof option}:${String(option)}`} value={index}>
                          {String(option)}
                        </option>
                      ))}
                    </select>
                  ) : field.schema.type === "boolean" ? (
                    <select
                      id={controlId}
                      value={current === true ? "true" : current === false ? "false" : ""}
                      onChange={(event) =>
                        update(
                          event.target.value === "" ? undefined : event.target.value === "true",
                        )
                      }
                    >
                      <option value="">Choose a value</option>
                      <option value="true">Yes</option>
                      <option value="false">No</option>
                    </select>
                  ) : (
                    <input
                      id={controlId}
                      type={
                        item.secret
                          ? "password"
                          : ["number", "integer"].includes(String(field.schema.type))
                            ? "number"
                            : "text"
                      }
                      step={field.schema.type === "integer" ? 1 : "any"}
                      value={
                        typeof current === "string" || typeof current === "number" ? current : ""
                      }
                      autoComplete={item.secret ? "off" : undefined}
                      onChange={(event) =>
                        update(
                          event.target.type === "number"
                            ? event.target.value === ""
                              ? undefined
                              : event.target.valueAsNumber
                            : event.target.value,
                        )
                      }
                    />
                  )}
                  {typeof field.schema.description === "string" ? (
                    <span className="sm dim">{field.schema.description}</span>
                  ) : null}
                </label>
              );
            })}
          </fieldset>
        );
      })}
      {touched && !valid ? (
        <p className="interaction-error" aria-live="polite">
          Complete the required fields using the form’s declared types and limits.
        </p>
      ) : null}
      <div className="interaction-buttons">
        <button type="submit" className="btn pri" disabled={disabled || !valid}>
          Accept form
        </button>
        <button type="button" className="btn" disabled={disabled} onClick={decline}>
          Decline
        </button>
      </div>
    </form>
  );
}

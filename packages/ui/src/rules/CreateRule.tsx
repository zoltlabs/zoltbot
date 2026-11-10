import { useMutation } from "@tanstack/react-query";
import { ApprovalRuleSchema, parse, type RuleDraft, terms } from "@zoltbot/protocol";
import { useEffect, useId, useRef, useState } from "react";
import type { ChatConnection } from "../chat/types.js";
import { matcherLabel, type RuleFields, ruleDraft, ruleError } from "./rule-data.js";

export interface ScopeOption {
  id: string;
  label: string;
}
type Attempt = { key: string; rule: RuleDraft; commandId: string };
export default function CreateRule({
  connection,
  profiles,
  projects,
  tools,
  onCreated,
  onCancel,
}: {
  connection: ChatConnection;
  profiles: ScopeOption[];
  projects: ScopeOption[];
  tools: string[];
  onCreated(): void;
  onCancel(): void;
}) {
  const id = useId();
  const [fields, setFields] = useState<RuleFields>({
    scope: "agent",
    scopeId: "",
    tool: "execute",
    prefix: "",
    decision: "allow",
    expiry: "never",
  });
  const [review, setReview] = useState(false),
    [error, setError] = useState("");
  const attempt = useRef<Attempt | undefined>(undefined);
  const prefix = useRef<HTMLInputElement>(null),
    heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (review) heading.current?.focus();
    else prefix.current?.focus();
  }, [review]);
  const save = useMutation({
    mutationFn: async (value: Attempt) =>
      parse(
        ApprovalRuleSchema,
        await connection.call(
          "rule.create",
          { rule: value.rule, confirmed: true },
          value.commandId,
        ),
      ),
    onSuccess: onCreated,
    onError: (failure) => {
      setError(ruleError(failure));
      if (failure instanceof Error && failure.message.includes("command_receipt_conflict")) {
        attempt.current = undefined;
        setReview(false);
      }
    },
    retry: false,
  });
  function change<K extends keyof RuleFields>(key: K, value: RuleFields[K]) {
    setFields((current) => ({ ...current, [key]: value }));
    setError("");
  }
  function prepare() {
    try {
      const key = JSON.stringify(fields);
      if (attempt.current?.key !== key)
        attempt.current = {
          key,
          rule: ruleDraft(fields, Date.now()),
          commandId: crypto.randomUUID(),
        };
      setError("");
      setReview(true);
    } catch (failure) {
      setError(ruleError(failure));
    }
  }
  const selected = fields.scope === "agent" ? profiles : projects;
  const scope =
    fields.scope === "global"
      ? `All ${terms.profile.many} and ${terms.workspace.many}`
      : `${fields.scope === "agent" ? terms.profile.One : terms.workspace.One}: ${selected.find((option) => option.id === fields.scopeId)?.label ?? "Choose an available scope"}`;
  return (
    <section
      className="card rules-create"
      aria-label="Create approval rule"
      aria-busy={save.isPending}
    >
      {review && attempt.current ? (
        <>
          <h2 ref={heading} tabIndex={-1}>
            Review approval rule
          </h2>
          <dl className="rules-review">
            <div>
              <dt>Decision</dt>
              <dd>{fields.decision === "allow" ? "Allow" : "Deny"}</dd>
            </div>
            <div>
              <dt>Command prefix</dt>
              <dd>
                <code dir="ltr">{matcherLabel(attempt.current.rule)}</code>
              </dd>
            </div>
            <div>
              <dt>Scope</dt>
              <dd>
                <bdi>{scope}</bdi>
              </dd>
            </div>
            <div>
              <dt>Expiry</dt>
              <dd>
                {attempt.current.rule.expiresAt
                  ? new Date(attempt.current.rule.expiresAt).toLocaleString()
                  : "No expiry"}
              </dd>
            </div>
          </dl>
          {error ? (
            <p className="rules-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="rules-actions">
            <button
              className="btn"
              type="button"
              disabled={save.isPending}
              onClick={() => setReview(false)}
            >
              Back
            </button>
            <button
              className="btn pri"
              type="button"
              disabled={save.isPending || connection.status !== "online"}
              onClick={() => {
                if (attempt.current) save.mutate(attempt.current);
              }}
            >
              {save.isPending ? "Saving rule…" : `Create ${fields.decision} rule`}
            </button>
            <button className="btn" type="button" disabled={save.isPending} onClick={onCancel}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            prepare();
          }}
          noValidate
        >
          <h2>New approval rule</h2>
          <div className="rules-form-grid">
            <label htmlFor={`${id}-prefix`} className="rules-wide">
              Command prefix
              <input
                id={`${id}-prefix`}
                ref={prefix}
                value={fields.prefix}
                maxLength={16000}
                spellCheck={false}
                autoComplete="off"
                placeholder="git status"
                onChange={(event) => change("prefix", event.target.value)}
                aria-describedby={`${id}-prefix-help`}
              />
            </label>
            <p id={`${id}-prefix-help`} className="dim rules-wide rules-help">
              The rule matches these arguments at the start of a single command.
            </p>
            <div className="rules-field">
              <label htmlFor={`${id}-tool`}>Tool</label>
              <select
                id={`${id}-tool`}
                value={fields.tool}
                onChange={(event) => change("tool", event.target.value)}
              >
                {tools.map((tool) => (
                  <option key={tool} value={tool}>
                    {tool === "execute" ? "Command tools" : tool}
                  </option>
                ))}
              </select>
            </div>
            <div className="rules-field">
              <label htmlFor={`${id}-decision`}>Decision</label>
              <select
                id={`${id}-decision`}
                value={fields.decision}
                onChange={(event) =>
                  change("decision", event.target.value as RuleFields["decision"])
                }
              >
                <option value="allow">Allow</option>
                <option value="deny">Deny</option>
              </select>
            </div>
            <div className="rules-field">
              <label htmlFor={`${id}-scope`}>Rule scope</label>
              <select
                id={`${id}-scope`}
                value={fields.scope}
                onChange={(event) => change("scope", event.target.value as RuleFields["scope"])}
              >
                <option value="agent">Profile</option>
                <option value="project">Project</option>
                <option value="global">Global</option>
              </select>
            </div>
            {fields.scope !== "global" ? (
              <div className="rules-field">
                <label htmlFor={`${id}-target`}>
                  {fields.scope === "agent" ? terms.profile.One : terms.workspace.One}
                </label>
                <select
                  id={`${id}-target`}
                  value={fields.scopeId}
                  onChange={(event) => change("scopeId", event.target.value)}
                >
                  <option value="">
                    Choose a {fields.scope === "agent" ? terms.profile.one : terms.workspace.one}
                  </option>
                  {selected.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <p className="dim rules-scope-note">
                Applies to every {terms.profile.one} and {terms.workspace.one}.
              </p>
            )}
            <div className="rules-field">
              <label htmlFor={`${id}-expiry`}>Expires after</label>
              <select
                id={`${id}-expiry`}
                value={fields.expiry}
                onChange={(event) => change("expiry", event.target.value as RuleFields["expiry"])}
              >
                <option value="never">No expiry</option>
                <option value="hour">1 hour</option>
                <option value="day">1 day</option>
                <option value="week">7 days</option>
              </select>
            </div>
          </div>
          {error ? (
            <p className="rules-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="rules-actions">
            <button className="btn pri" type="submit" disabled={connection.status !== "online"}>
              Review rule
            </button>
            <button className="btn" type="button" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

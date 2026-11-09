import {
  ApprovalRuleSchema,
  type Interaction,
  parse,
  type RuleDraft,
  terms,
} from "@zoltbot/protocol";
import { useEffect, useId, useRef, useState } from "react";
import type { ChatConnection } from "../chat/types.js";
import { matcherLabel, type RuleFields, ruleError, suggestedRule } from "../rules/rule-data.js";

type Scope = RuleFields["scope"];
/**
 * "Always allow" from an approval: previews the provider's suggested rule with a scope selector,
 * saves it through rule.create (I13: the save is the explicit confirmation), then allows this
 * request once.
 */
export function AlwaysAllowRule({
  connection,
  request,
  suggestion,
  disabled,
  onCreated,
  onCancel,
}: {
  connection: ChatConnection;
  request: Interaction;
  suggestion: RuleDraft["matcher"];
  disabled: boolean;
  onCreated(): void;
  onCancel(): void;
}) {
  const id = useId();
  const entities = connection.snapshot.entities;
  const profile = entities.agent?.find((row) => row.id === request.agentId);
  const thread = entities.thread?.find((row) => row.id === request.threadId);
  const projectId = typeof thread?.projectId === "string" ? thread.projectId : undefined;
  const project = entities.project?.find((row) => row.id === projectId);
  const [scope, setScope] = useState<Scope>("agent"),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const attempt = useRef<{ key: string; id: string } | undefined>(undefined);
  const heading = useRef<HTMLHeadingElement>(null);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    // The pending area scrolls; bring the whole panel, including its actions, into view.
    panel.current?.scrollIntoView({ block: "nearest" });
  }, []);
  const scopeId = scope === "agent" ? request.agentId : scope === "project" ? projectId : undefined;
  let rule: RuleDraft | undefined;
  try {
    rule = suggestedRule(suggestion, scope, scopeId);
  } catch {}
  const save = async () => {
    if (!rule) return;
    const key = JSON.stringify(rule);
    if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() };
    setSaving(true);
    setError("");
    try {
      parse(
        ApprovalRuleSchema,
        await connection.call("rule.create", { rule, confirmed: true }, attempt.current.id),
      );
      onCreated();
    } catch (failure) {
      setError(ruleError(failure));
      if (failure instanceof Error && failure.message.includes("command_receipt_conflict"))
        attempt.current = undefined;
    } finally {
      setSaving(false);
    }
  };
  const profileName = typeof profile?.name === "string" ? profile.name : "This profile";
  const projectName =
    typeof project?.name === "string" ? project.name : `This ${terms.workspace.one}`;
  return (
    <section
      ref={panel}
      className="interaction-rule"
      aria-labelledby={`${id}-title`}
      aria-busy={saving}
    >
      <h3 id={`${id}-title`} ref={heading} tabIndex={-1}>
        Always allow
      </h3>
      <p className="sm dim">
        Future matching requests run without asking. You can revoke the rule in Settings, Rules.
      </p>
      <p className="interaction-rule-matcher">
        Allow <code dir="ltr">{matcherLabel({ matcher: suggestion })}</code>
      </p>
      <fieldset className="interaction-rule-scope" disabled={saving || disabled}>
        <legend>Applies to</legend>
        <label>
          <input
            type="radio"
            name={`${id}-scope`}
            checked={scope === "agent"}
            onChange={() => setScope("agent")}
          />
          Profile: <bdi>{profileName}</bdi>
        </label>
        <label>
          <input
            type="radio"
            name={`${id}-scope`}
            checked={scope === "project"}
            disabled={!projectId}
            onChange={() => setScope("project")}
          />
          {terms.workspace.One}:{" "}
          <bdi>{projectId ? projectName : `No ${terms.workspace.one} for this conversation`}</bdi>
        </label>
        <label>
          <input
            type="radio"
            name={`${id}-scope`}
            checked={scope === "global"}
            onChange={() => setScope("global")}
          />
          Every {terms.profile.one} and {terms.workspace.one}
        </label>
      </fieldset>
      {error ? (
        <p className="interaction-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="interaction-buttons">
        <button
          type="button"
          className="btn pri"
          disabled={!rule || saving || disabled || connection.status !== "online"}
          onClick={() => void save()}
        >
          {saving ? "Saving rule…" : "Save rule and allow"}
        </button>
        <button type="button" className="btn" disabled={saving} onClick={onCancel}>
          Back
        </button>
      </div>
    </section>
  );
}

import { useEffect, useId, useState } from "react";
import type { ChatConnection } from "../chat/types.js";
import { text } from "../chat/types.js";
import { readOnlyReason } from "./compare-state.js";
import "./compare.css";
export function ComparePicker({
  connection,
  threadId,
  selected,
  onChange,
  disabled,
}: {
  connection: ChatConnection;
  threadId: string;
  selected: string[];
  onChange(ids: string[]): void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const [definitions, setDefinitions] = useState(
    connection.snapshot.entities.agentDefinition ?? [],
  );
  useEffect(() => {
    if (!open) return;
    let live = true;
    void connection
      .call("agentDefinition.list", {})
      .then((result) => {
        const items = (result as { items?: Record<string, unknown>[] }).items;
        if (live && items) setDefinitions(items);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [open, connection.call]);
  const [access, setAccess] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!open) return;
    let live = true;
    void connection
      .call("doctor.report", {})
      .then((result) => {
        const checks = (result as { checks?: Record<string, unknown>[] }).checks ?? [];
        const reasons: Record<string, string> = {};
        for (const check of checks) {
          if (check.kind !== "agent") continue;
          const install = check.install as { selected?: { path?: string } } | undefined;
          const login = check.login as { state?: string } | undefined;
          if (login?.state === "signed_out")
            reasons[String(check.definitionId)] = "Sign in to your coding tool in Setup";
          else if (!install?.selected?.path)
            reasons[String(check.definitionId)] = "Coding tool is offline or not installed";
        }
        if (live) setAccess(reasons);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [open, connection.call]);
  const entities = connection.snapshot.entities;
  const thread = entities.thread?.find((r) => r.id === threadId);
  const profiles = (entities.agent ?? [])
    .filter((r) => !r.archived && !r.hidden && r.kind === "profile")
    .sort((a, b) => Number(b.id === thread?.agentId) - Number(a.id === thread?.agentId));
  useEffect(() => {
    if (disabled) setOpen(false);
    const key = (event: KeyboardEvent) => {
      if (
        !disabled &&
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "m"
      ) {
        event.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [disabled]);
  return (
    <div className="compare-picker">
      <button
        type="button"
        className="btn sm"
        disabled={disabled}
        aria-expanded={open}
        aria-controls={id}
        aria-keyshortcuts="Meta+Shift+M"
        onClick={() => {
          if (!selected.length && thread?.agentId) onChange([text(thread.agentId)]);
          setOpen(!open);
        }}
      >
        + Compare
      </button>
      {open ? (
        <fieldset
          id={id}
          className="compare-picker-panel"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setOpen(false);
              event.currentTarget.parentElement
                ?.querySelector<HTMLButtonElement>("button")
                ?.focus();
            }
          }}
        >
          <legend>Compare 2–4 profiles</legend>
          {profiles.map((profile) => {
            const capabilityReason = readOnlyReason(
              profile,
              definitions,
              connection.status === "online",
            );
            const reason = capabilityReason || access[text(profile.definitionId)] || "";
            const checked = selected.includes(text(profile.id));
            const definition = entities.agentDefinition?.find((r) => r.id === profile.definitionId);
            return (
              <label key={text(profile.id)} className="compare-picker-option">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!!reason || (!checked && selected.length === 4)}
                  onChange={() =>
                    onChange(
                      checked
                        ? selected.filter((v) => v !== profile.id)
                        : [...selected, text(profile.id)],
                    )
                  }
                />
                <span>
                  <strong>{text(profile.name)}</strong>
                  <small>
                    {[text(definition?.displayName), text(profile.model), text(profile.effort)]
                      .filter(Boolean)
                      .join(" · ")}
                  </small>
                  {reason ? <small>{reason}</small> : null}
                </span>
              </label>
            );
          })}
          <button className="btn sm" type="button" onClick={() => setOpen(false)}>
            Done
          </button>
        </fieldset>
      ) : null}
      {selected.length > 1 ? (
        <div className="compare-chips">
          {selected.map((profileId) => (
            <button
              className="btn sm"
              type="button"
              key={profileId}
              aria-label={`Remove ${text(profiles.find((r) => r.id === profileId)?.name)}`}
              onClick={() => onChange(selected.filter((v) => v !== profileId))}
            >
              {text(profiles.find((r) => r.id === profileId)?.name)} ×
            </button>
          ))}
          <span className="compare-readonly">Read only · no edits</span>
        </div>
      ) : null}
    </div>
  );
}

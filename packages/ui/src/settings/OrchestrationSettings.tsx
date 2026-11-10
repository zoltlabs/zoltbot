import { terms } from "@zoltbot/protocol";
import { useState } from "react";
import type { ChatConnection } from "../chat/types.js";

const roles = ["plan", "implement", "review", "tests"] as const;
export function OrchestrationSettings({ connection }: { connection: ChatConnection }) {
  const [projectId, setProjectId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const key = projectId ? `orchestration.roles.${projectId}` : "orchestration.roles";
  const stored = connection.snapshot.entities.settings?.find((row) => row.key === key)?.value;
  const defaults =
    stored && typeof stored === "object" && !Array.isArray(stored)
      ? (stored as Record<string, { profile?: string }>)
      : {};
  const profiles = (connection.snapshot.entities.agent ?? []).filter(
    (row) => !row.archived && !row.hidden,
  );
  async function save(role: string, profile: string) {
    setSaving(true);
    setError("");
    const value = { ...defaults };
    if (profile) value[role] = { profile };
    else delete value[role];
    try {
      await connection.call("settings.set", { key, value }, crypto.randomUUID());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="zb-card settings-panel" aria-label="Task model defaults">
      <h2>Task model defaults</h2>
      <p className="settings-hint">
        Each profile supplies the default model and effort for its phase. Instructions in your chat
        take priority.
      </p>
      <label className="settings-field">
        Apply defaults to
        <select
          value={projectId}
          disabled={saving}
          onChange={(event) => setProjectId(event.target.value)}
        >
          <option value="">All {terms.workspace.many}</option>
          {(connection.snapshot.entities.project ?? [])
            .filter((project) => !project.archived)
            .map((project) => (
              <option key={String(project.id)} value={String(project.id)}>
                {String(project.name)}
              </option>
            ))}
        </select>
      </label>
      {roles.map((role) => (
        <label key={role} className="settings-field">
          {role === "tests" ? "Unit tests" : role[0]?.toUpperCase() + role.slice(1)}
          <select
            value={defaults[role]?.profile ?? ""}
            disabled={saving || connection.status !== "online"}
            onChange={(event) => void save(role, event.target.value)}
          >
            <option value="">{projectId ? "Use app default" : "Automatic"}</option>
            {profiles.map((profile) => (
              <option key={String(profile.id)} value={String(profile.id)}>
                {String(profile.name)}
                {profile.model ? ` · ${profile.model}` : ""}
                {profile.effort ? ` · ${profile.effort}` : ""}
              </option>
            ))}
          </select>
        </label>
      ))}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

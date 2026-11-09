import { type Scope, terms } from "@zoltbot/protocol";
import { useId, useState } from "react";
import type { ChatConnection } from "../chat/types.js";

export const userScope: Scope = { type: "user", id: "local" };
export const userScopeName = `You (all ${terms.workspace.many})`;

/** The workspace that owns a project or team scope. */
export function projectIdOf(connection: ChatConnection, scope: Scope) {
  if (scope.type === "project") return scope.id;
  const row = connection.snapshot.entities.subproject?.find((entry) => entry.id === scope.id);
  return typeof row?.projectId === "string" ? row.projectId : undefined;
}

/** Switch between this workspace's knowledge and the user scope, plus the per-project opt-out. */
export function KnowledgeScopeBar({
  connection,
  scope,
  viewingUser,
  setViewingUser,
}: {
  connection: ChatConnection;
  scope: Scope;
  viewingUser: boolean;
  setViewingUser(value: boolean): void;
}) {
  const id = useId();
  const [error, setError] = useState("");
  const projectId = projectIdOf(connection, scope);
  const key = `knowledge.inheritUser.${projectId}`;
  const inherits =
    connection.snapshot.entities.settings?.find((row) => row.key === key)?.value !== false;
  return (
    <div className="r wrap knowledge-scope-bar">
      <fieldset className="r">
        <legend>Knowledge scope</legend>
        <label>
          <input
            type="radio"
            name={`${id}-scope`}
            checked={!viewingUser}
            onChange={() => setViewingUser(false)}
          />
          This {terms.workspace.one}
        </label>
        <label>
          <input
            type="radio"
            name={`${id}-scope`}
            checked={viewingUser}
            onChange={() => setViewingUser(true)}
          />
          {userScopeName}
        </label>
      </fieldset>
      {projectId ? (
        <label className="dim sm">
          <input
            type="checkbox"
            checked={inherits}
            onChange={() => {
              setError("");
              connection
                .call("settings.set", { key, value: !inherits }, crypto.randomUUID())
                .catch(() => setError("Could not change this setting. Try again when connected."));
            }}
          />
          Use your personal knowledge in this {terms.workspace.one}
        </label>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}

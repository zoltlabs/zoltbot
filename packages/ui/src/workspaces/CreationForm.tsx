import { ProjectSchema, parse, SubprojectSchema, ThreadSchema, terms } from "@zoltbot/protocol";
import { useEffect, useId, useRef, useState } from "react";
import { type ChatConnection, type Row, text } from "../chat/types.js";
import type { WorkspaceScope } from "./view.js";

export type CreationMode = "workspace" | "direction" | "manager" | "chat";
const { workspace, team, manager, chat } = terms;
const titles = {
  workspace: `New ${workspace.one}`,
  direction: `New ${team.one}`,
  manager: `Assign ${manager.one}`,
  chat: `New ${chat.one}`,
};
const actions = {
  workspace: `Create ${workspace.one}`,
  direction: `Create ${team.one}`,
  manager: `Save ${manager.one}`,
  chat: `Create ${chat.one}`,
};
const errors: Record<string, string> = {
  manager_already_assigned: `This ${team.one} already has a ${manager.one}.`,
  duplicate_scope_name: `A ${team.one} with this name already exists here.`,
  profile_unavailable: `Choose an available ${terms.profile.one}.`,
  private_value_requires_secure_field:
    "This contains a protected value. Use a secure field for secrets.",
  scope_unavailable: `This ${team.one} is no longer available.`,
  invalid_hierarchy: `The parent ${team.one} changed. Review the selected ${team.one}.`,
};
export function CreationForm({
  mode,
  connection,
  scope,
  projectId,
  parentDepth,
  profiles,
  defaultProfile,
  onDone,
  onCancel,
}: {
  mode: CreationMode;
  connection: ChatConnection;
  scope: WorkspaceScope | undefined;
  projectId: string | undefined;
  parentDepth: number;
  profiles: Row[];
  defaultProfile: string;
  onDone(kind: "project" | "subproject" | "thread", id: string): void;
  onCancel(): void;
}) {
  const label = useId(),
    nameRef = useRef<HTMLInputElement>(null),
    profileRef = useRef<HTMLSelectElement>(null);
  const [name, setName] = useState(""),
    [folder, setFolder] = useState(""),
    [picking, setPicking] = useState(false);
  const [profileId, setProfileId] = useState(defaultProfile),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const request = useRef<{ key: string; id: string; at: string; commandId: string } | undefined>(
    undefined,
  );
  useEffect(() => {
    if (mode === "manager") profileRef.current?.focus();
    else nameRef.current?.focus();
  }, [mode]);
  const needsProfile = mode === "manager" || mode === "chat";
  return (
    <form
      className="card scope-form"
      aria-label={titles[mode]}
      onSubmit={async (event) => {
        event.preventDefault();
        setError("");
        if (needsProfile && !profiles.some((row) => row.id === profileId)) {
          setError(`Choose an available ${terms.profile.one}.`);
          return;
        }
        if (folder.trim() && !folder.trim().startsWith("/")) {
          setError("Enter an absolute code folder path.");
          return;
        }
        const trimmed = name.trim();
        if (mode !== "manager" && !trimmed) {
          setError("Enter a name.");
          return;
        }
        const key = JSON.stringify([mode, scope, projectId, trimmed, folder, profileId]);
        if (request.current?.key !== key)
          request.current = {
            key,
            id: crypto.randomUUID(),
            at: new Date().toISOString(),
            commandId: crypto.randomUUID(),
          };
        const draft = request.current;
        let value: Row, method: string, kind: "project" | "subproject" | "thread";
        if (mode === "workspace") {
          kind = "project";
          method = "project.create";
          value = {
            id: draft.id,
            name: trimmed,
            // Instructions live in the repository's AGENTS.md, not in Zolt.
            goal: "",
            instructions: "",
            constraints: "",
            roots: folder.trim() ? [{ path: folder.trim(), label: "Code" }] : [],
            hierarchyDepth: 3,
            tags: [],
            requireCodeReview: false,
            skipFinalGateWhenReviewed: false,
            archived: false,
            createdAt: draft.at,
          };
        } else if (mode === "direction") {
          kind = "subproject";
          method = "subproject.create";
          value = {
            id: draft.id,
            projectId,
            ...(scope?.type === "subproject" ? { parentId: scope.id } : {}),
            name: trimmed,
            label: terms.team.One,
            goal: "",
            instructions: "",
            depth: parentDepth + 1,
            archived: false,
            createdAt: draft.at,
          };
        } else {
          kind = "thread";
          method = "thread.create";
          value = {
            id: draft.id,
            agentId: profileId,
            projectId,
            node: scope,
            kind: mode === "manager" ? "manager" : "side",
            title: mode === "manager" ? "Manager" : trimmed,
            titleSource: "human",
            pinned: false,
            archived: false,
            createdAt: draft.at,
            lastActivityAt: draft.at,
          };
        }
        setPending(true);
        try {
          const result = await connection.call(
            method,
            { value, ...(mode === "manager" ? { confirmed: true } : {}) },
            draft.commandId,
          );
          const saved = parse(
            kind === "project"
              ? ProjectSchema
              : kind === "subproject"
                ? SubprojectSchema
                : ThreadSchema,
            result,
          );
          if (saved.id !== draft.id) throw new Error("unexpected_receipt");
          onDone(kind, saved.id);
        } catch (failure) {
          setError(
            errors[failure instanceof Error ? failure.message : ""] ??
              "Could not save. Your draft is kept so you can retry.",
          );
        } finally {
          setPending(false);
        }
      }}
    >
      <h2>{titles[mode]}</h2>
      {mode === "manager" ? (
        <p className="dim">
          Choose the {terms.profile.one} for this{" "}
          {scope?.type === "project" ? workspace.one : team.one}
          ’s persistent {manager.one}. It can brief {chat.many} and {team.many} below it, and they
          report back to it. Connecting it starts its coding tool.
        </p>
      ) : null}
      {mode !== "manager" ? (
        <>
          <label htmlFor={`${label}-name`}>
            {mode === "workspace"
              ? `${workspace.One} name`
              : mode === "direction"
                ? `${team.One} name`
                : `${chat.One} title`}
          </label>
          <input
            ref={nameRef}
            id={`${label}-name`}
            value={name}
            maxLength={150}
            required
            disabled={pending}
            onChange={(event) => setName(event.target.value)}
          />
        </>
      ) : null}
      {mode === "workspace" ? (
        <>
          <label htmlFor={`${label}-folder`}>Code folder (optional)</label>
          <input
            id={`${label}-folder`}
            value={folder}
            disabled={pending || picking}
            placeholder="/absolute/path/to/code"
            onChange={(event) => setFolder(event.target.value)}
          />
          <p className="dim sm">
            Leave this empty to give each {chat.one} a private app folder. {team.Many} inherit this{" "}
            {workspace.one}’s selected code folder.
          </p>
          {window.zoltDesktop?.pickFolders ? (
            <button
              type="button"
              className="btn"
              disabled={pending || picking}
              onClick={async () => {
                setPicking(true);
                setError("");
                try {
                  const selected = await window.zoltDesktop?.pickFolders?.();
                  if (selected?.length === 1) setFolder(selected[0] ?? "");
                  else if (selected?.length)
                    setError(`Choose one code folder for this ${workspace.one}.`);
                } catch {
                  setError("Could not choose a folder. Enter its absolute path or try again.");
                } finally {
                  setPicking(false);
                }
              }}
            >
              {picking ? "Choosing folder…" : "Choose code folder"}
            </button>
          ) : null}
        </>
      ) : null}
      {needsProfile ? (
        <>
          <label htmlFor={`${label}-profile`}>{terms.profile.One}</label>
          <select
            ref={profileRef}
            id={`${label}-profile`}
            value={profileId}
            disabled={pending}
            required
            onChange={(event) => setProfileId(event.target.value)}
          >
            <option value="">Choose a {terms.profile.one}</option>
            {profiles.map((profile) => (
              <option key={text(profile.id)} value={text(profile.id)}>
                {text(profile.name)}
              </option>
            ))}
          </select>
        </>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      <div className="r wrap">
        <button
          type="submit"
          className="btn pri"
          disabled={pending || picking || connection.status !== "online"}
        >
          {pending ? "Saving…" : actions[mode]}
        </button>
        <button type="button" className="btn" disabled={pending} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

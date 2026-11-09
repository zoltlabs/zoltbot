import type {
  DetectedSkillView as DetectedSkill,
  SkillBundleView as SkillBundle,
  SkillEntryView as SkillEntry,
  SkillRevisionView as SkillRevision,
} from "@zoltbot/protocol";
import { terms } from "@zoltbot/protocol";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ChatConnection } from "../chat/types.js";
import { Button } from "../components/primitives.js";
import { skillVersionDiff } from "./diff.js";
import "./skills.css";
interface Detail {
  entry: SkillEntry;
  revision: SkillRevision;
  history: SkillRevision[];
}
interface Preview {
  previewId: string;
  bundle: SkillBundle;
  source: string;
}
export function SkillsSettings({ connection }: { connection: ChatConnection }) {
  const [skills, setSkills] = useState<SkillEntry[]>([]),
    [detail, setDetail] = useState<Detail>(),
    [detected, setDetected] = useState<DetectedSkill[]>([]),
    [tab, setTab] = useState("library");
  const [preview, setPreview] = useState<Preview>(),
    [update, setUpdate] = useState(false),
    [folder, setFolder] = useState("");
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false),
    [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [body, setBody] = useState(""),
    [extraFiles, setExtraFiles] = useState<{ path: string; content: string }[]>([]),
    [compareVersion, setCompareVersion] = useState(1);
  const [profileId, setProfile] = useState(""),
    [scopeId, setScope] = useState(""),
    [assigned, setAssigned] = useState<{ skillId: string; revision: number }[]>([]);
  const [confirmation, setConfirmation] = useState<"enable" | "remove">(),
    dialog = useRef<HTMLDialogElement>(null),
    title = useId();
  const online = connection.status === "online";
  const profiles = connection.snapshot.entities.agent ?? [],
    scopes = [
      ...(connection.snapshot.entities.project ?? []),
      ...(connection.snapshot.entities.subproject ?? []),
    ];
  const call = useCallback(
    (method: string, params: unknown = {}) => connection.call(method, params, crypto.randomUUID()),
    [connection.call],
  );
  const refresh = useCallback(async () => {
    const result = (await call("skill.list")) as { skills: SkillEntry[] };
    setSkills(result.skills);
  }, [call]);
  async function action(work: () => Promise<void>) {
    if (busy || !online) return;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not save. Your draft is preserved; try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (online)
      void refresh().catch(() => setError("Skills could not be loaded. Reconnect and retry."));
  }, [online, refresh]);
  useEffect(() => {
    if (confirmation) dialog.current?.showModal();
    else dialog.current?.close();
  }, [confirmation]);
  useEffect(() => {
    if (profileId && scopeId && online)
      void call("skill.assignments", { profileId, scopeId })
        .then((r) =>
          setAssigned((r as { assignments: { skillId: string; revision: number }[] }).assignments),
        )
        .catch(() => setError("Could not load profile access."));
    else setAssigned([]);
  }, [profileId, scopeId, online, call]);
  async function open(id: string) {
    const result = (await call("skill.get", { id })) as Detail;
    setDetail(result);
    setEditing(false);
    setPreview(undefined);
  }
  function edit(value?: Detail) {
    setName(value?.revision.bundle.name ?? "");
    setDescription(value?.revision.bundle.description ?? "");
    setBody(value?.revision.bundle.body ?? "");
    setExtraFiles(value?.revision.bundle.files.filter((file) => file.path !== "SKILL.md") ?? []);
    setEditing(true);
  }
  const files = () => [
    {
      path: "SKILL.md",
      content: `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n${body}\n`,
    },
    ...extraFiles,
  ];
  async function importFolder(source: string) {
    setPreview((await call("skill.import.preview", { folder: source })) as Preview);
    setUpdate(false);
  }
  const unavailable = busy || !online;
  return (
    <section className="zb-card settings-panel skills-settings" aria-labelledby={title}>
      <h2 id={title}>Skills</h2>
      <p className="settings-hint">
        Reusable instructions, files and scripts. Versions used by sessions stay fixed.
      </p>
      <p className="dim sm">
        Native loading is checked at start. Unsupported selections block start. Import and editing
        never run scripts.
      </p>
      <div className="r">
        <Button onClick={() => setTab("library")} aria-pressed={tab === "library"}>
          Local library
        </Button>
        <Button
          onClick={() =>
            void action(async () => {
              setDetected(((await call("skill.detect")) as { skills: DetectedSkill[] }).skills);
              setTab("detected");
            })
          }
        >
          Detected skills
        </Button>
        <span className="sp" />
        <Button
          onClick={() => {
            setDetail(undefined);
            edit();
          }}
        >
          New skill
        </Button>
      </div>
      {error && <p role="alert">{error} Your draft is preserved.</p>}
      <output aria-live="polite">{notice}</output>
      {!online && (
        <p id={`${title}-offline`}>Reconnect to manage skills. Your draft is preserved.</p>
      )}
      <form
        className="skills-import"
        onSubmit={(e) => {
          e.preventDefault();
          void action(() => importFolder(folder));
        }}
      >
        <label>
          Local skill folder
          <input
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            placeholder="/path/to/skill"
            required
          />
        </label>
        <Button
          type="button"
          onClick={() =>
            void action(async () => {
              const selected = await window.zoltDesktop?.pickFolders?.();
              if (selected?.[0]) {
                setFolder(selected[0]);
                await importFolder(selected[0]);
              }
            })
          }
        >
          Choose folder…
        </Button>
        <Button
          type="submit"
          aria-disabled={unavailable}
          onClick={(e) => {
            if (unavailable) e.preventDefault();
          }}
        >
          Review import
        </Button>
      </form>
      {tab === "detected" ? (
        <ul>
          {detected.map((row) => (
            <li key={row.source}>
              <strong>{row.name ?? "Unreadable skill"}</strong>
              <p className="dim">
                {row.provider} · {row.source}
              </p>
              {row.error ? (
                <p>{row.error}</p>
              ) : (
                <Button onClick={() => void action(() => importFolder(row.source))}>
                  Add to library (copy)
                </Button>
              )}
              <p className="dim sm">The original stays where it is.</p>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="skills-list">
          {skills.map((skill) => (
            <li key={skill.id}>
              <Button onClick={() => void action(() => open(skill.id))}>
                {skill.name} · v{skill.current_revision}
              </Button>
              <span className="dim">{skill.source ? "Imported copy" : "Created here"}</span>
            </li>
          ))}
        </ul>
      )}
      {!skills.length && tab === "library" && (
        <p>No skills yet. Create one or review a local folder.</p>
      )}
      {preview && (
        <section aria-label="Import preview" className="skills-detail">
          <h3>
            {update ? "Update" : "Add"} {preview.bundle.name}
          </h3>
          <p>{preview.bundle.description}</p>
          <p className="dim">Source: {preview.source}</p>
          <h4>Files</h4>
          <ul>
            {preview.bundle.files.map((f) => (
              <li key={f.path}>
                {f.path} · {f.bytes} bytes
              </li>
            ))}
          </ul>
          <ul>
            {preview.bundle.warnings.map((w) => (
              <li key={w}>⚠ {w}</li>
            ))}
          </ul>
          <details>
            <summary>Read SKILL.md</summary>
            <pre>{preview.bundle.files.find((f) => f.path === "SKILL.md")?.content}</pre>
          </details>
          {update && detail && (
            <>
              <p>Choose how to handle local edits. All prior versions remain in history.</p>
              <details>
                <summary>View differences as text</summary>
                <p>Current version</p>
                <pre>{detail.revision.bundle.body}</pre>
                <section aria-label="Source differences">
                  <pre>{skillVersionDiff(detail.revision.bundle.body, preview.bundle.body)}</pre>
                </section>
                <p>Source version</p>
                <pre>{preview.bundle.body}</pre>
              </details>
            </>
          )}
          <div className="r">
            <Button
              onClick={() => {
                setPreview(undefined);
                setUpdate(false);
              }}
            >
              Cancel
            </Button>
            {update && detail ? (
              <>
                <Button
                  onClick={() =>
                    void action(async () => {
                      await call("skill.update.apply", {
                        id: detail.entry.id,
                        expectedRevision: detail.entry.current_revision,
                        previewId: preview.previewId,
                        hash: preview.bundle.hash,
                        choice: "keep",
                      });
                      setPreview(undefined);
                      setNotice("Kept your version.");
                    })
                  }
                >
                  Keep mine
                </Button>
                <Button
                  onClick={() =>
                    void action(async () => {
                      await call("skill.update.apply", {
                        id: detail.entry.id,
                        expectedRevision: detail.entry.current_revision,
                        previewId: preview.previewId,
                        hash: preview.bundle.hash,
                        choice: "replace",
                      });
                      await open(detail.entry.id);
                      await refresh();
                      setNotice("Source saved. Your previous version is in history.");
                    })
                  }
                >
                  Use source
                </Button>
                <Button
                  onClick={() => {
                    setName(`${preview.bundle.name}-copy`.slice(0, 64));
                    setDescription(preview.bundle.description);
                    setBody(preview.bundle.body);
                    setExtraFiles(preview.bundle.files.filter((file) => file.path !== "SKILL.md"));
                    setDetail(undefined);
                    setEditing(true);
                    setPreview(undefined);
                  }}
                >
                  Save source as a copy
                </Button>
              </>
            ) : (
              <Button
                variant="primary"
                onClick={() =>
                  void action(async () => {
                    const result = (await call("skill.import.apply", {
                      previewId: preview.previewId,
                      hash: preview.bundle.hash,
                    })) as SkillEntry;
                    setPreview(undefined);
                    await refresh();
                    await open(result.id);
                    setNotice("Added a managed copy. Scripts were not run.");
                  })
                }
              >
                Add to library
              </Button>
            )}
          </div>
        </section>
      )}
      {editing && (
        <form
          className="skills-detail"
          onSubmit={(e) => {
            e.preventDefault();
            void action(async () => {
              const result = (await call("skill.save", {
                ...(detail
                  ? { id: detail.entry.id, expectedRevision: detail.entry.current_revision }
                  : {}),
                files: files(),
              })) as SkillEntry | SkillRevision;
              await refresh();
              await open("skillId" in result ? result.skillId : result.id);
              setNotice("Saved. Running sessions keep the version they started with.");
            });
          }}
        >
          <h3>{detail ? "Edit skill" : "New skill"}</h3>
          <label>
            Name
            <input
              value={name}
              required
              maxLength={64}
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Description
            <textarea
              aria-label="Description"
              required
              maxLength={1024}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <label>
            Instructions (Markdown)
            <textarea
              aria-label="Instructions (Markdown)"
              required
              className="skills-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </label>
          <div className="r">
            <Button type="button" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              aria-disabled={unavailable}
              onClick={(e) => {
                if (unavailable) e.preventDefault();
              }}
            >
              Save version
            </Button>
          </div>
        </form>
      )}
      {detail && !editing && (
        <section className="skills-detail" aria-label="Skill detail">
          <h3>
            {detail.entry.name} · v{detail.entry.current_revision}
          </h3>
          <p>{detail.revision.bundle.description}</p>
          <div className="r">
            <Button onClick={() => edit(detail)}>Edit</Button>
            <Button
              onClick={() => {
                setName(`${detail.entry.name}-copy`.slice(0, 64));
                setDescription(detail.revision.bundle.description);
                setBody(detail.revision.bundle.body);
                setExtraFiles(
                  detail.revision.bundle.files.filter((file) => file.path !== "SKILL.md"),
                );
                setDetail(undefined);
                setEditing(true);
              }}
            >
              Duplicate
            </Button>
            {detail.entry.source && (
              <Button
                onClick={() =>
                  void action(async () => {
                    setPreview(
                      (await call("skill.update.preview", { id: detail.entry.id })) as Preview,
                    );
                    setUpdate(true);
                  })
                }
              >
                Check source update
              </Button>
            )}
            <Button onClick={() => setConfirmation("remove")}>Remove</Button>
          </div>
          <details open>
            <summary>Instructions</summary>
            <pre>{detail.revision.bundle.body}</pre>
          </details>
          <details>
            <summary>Files</summary>
            {detail.revision.bundle.files.map((f) => (
              <details key={f.path}>
                <summary>
                  {f.path} · {f.bytes} bytes
                </summary>
                <pre>{f.content}</pre>
              </details>
            ))}
          </details>
          <details>
            <summary>Versions</summary>
            <label>
              Compare version with current
              <select
                value={compareVersion}
                onChange={(e) => setCompareVersion(Number(e.target.value))}
              >
                {detail.history.map((v) => (
                  <option key={v.revision} value={v.revision}>
                    v{v.revision}
                  </option>
                ))}
              </select>
            </label>
            <section aria-label="Version differences">
              <pre>
                {skillVersionDiff(
                  detail.history.find((v) => v.revision === compareVersion)?.bundle.body ?? "",
                  detail.revision.bundle.body,
                )}
              </pre>
            </section>
            {detail.history.map((version) => (
              <details key={version.revision}>
                <summary>
                  v{version.revision} · {version.createdAt}
                </summary>
                <pre>{version.bundle.body}</pre>
              </details>
            ))}
          </details>
          <details>
            <summary>Profile access</summary>
            <p>
              Enabling allows this profile to use the selected revision in this scope. Native setup
              must also be supported.
            </p>
            <label>
              Profile
              <select
                aria-label="Profile"
                value={profileId}
                onChange={(e) => setProfile(e.target.value)}
              >
                <option value="">Choose profile</option>
                {profiles.map((p) => (
                  <option key={String(p.id)} value={String(p.id)}>
                    {String(p.name)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Scope
              <select aria-label="Scope" value={scopeId} onChange={(e) => setScope(e.target.value)}>
                <option value="">
                  Choose {terms.workspace.one} or {terms.team.one}
                </option>
                {scopes.map((p) => (
                  <option key={String(p.id)} value={String(p.id)}>
                    {String(p.name)}
                  </option>
                ))}
              </select>
            </label>
            <p>
              {assigned.some((a) => a.skillId === detail.entry.id)
                ? `Enabled v${assigned.find((a) => a.skillId === detail.entry.id)?.revision}`
                : "Disabled"}
            </p>
            {assigned.some(
              (a) => a.skillId === detail.entry.id && a.revision !== detail.entry.current_revision,
            ) && (
              <Button
                aria-disabled={!profileId || !scopeId || unavailable}
                onClick={() => {
                  if (profileId && scopeId && !unavailable) setConfirmation("enable");
                }}
              >
                Use v{detail.entry.current_revision} for new sessions…
              </Button>
            )}
            <Button
              aria-disabled={!profileId || !scopeId || unavailable}
              onClick={() => {
                if (!profileId || !scopeId || unavailable) return;
                if (assigned.some((a) => a.skillId === detail.entry.id))
                  void action(async () => {
                    await call("skill.access", {
                      profileId,
                      scopeId,
                      skillId: detail.entry.id,
                      revision: detail.entry.current_revision,
                      enabled: false,
                      confirmed: false,
                    });
                    setAssigned(assigned.filter((a) => a.skillId !== detail.entry.id));
                    setNotice("Disabled for future sessions.");
                  });
                else setConfirmation("enable");
              }}
            >
              {assigned.some((a) => a.skillId === detail.entry.id)
                ? "Disable"
                : `Enable v${detail.entry.current_revision}…`}
            </Button>
          </details>
        </section>
      )}
      <dialog
        ref={dialog}
        aria-labelledby={`${title}-confirm`}
        onCancel={() => setConfirmation(undefined)}
        onClose={() => setConfirmation(undefined)}
      >
        <h3 id={`${title}-confirm`}>
          {confirmation === "enable"
            ? "Enable skill for this profile?"
            : "Remove skill from the library?"}
        </h3>
        <p>
          {confirmation === "enable"
            ? "Agents using this profile in the chosen scope can read these instructions and may run included scripts with their normal approvals. This applies to future sessions."
            : "Existing and resumable sessions retain their frozen version. Future sessions will not receive this skill."}
        </p>
        <div className="r">
          <Button onClick={() => setConfirmation(undefined)}>Cancel</Button>
          <Button
            onClick={() =>
              void action(async () => {
                if (!detail) return;
                if (confirmation === "enable") {
                  await call("skill.access", {
                    profileId,
                    scopeId,
                    skillId: detail.entry.id,
                    revision: detail.entry.current_revision,
                    enabled: true,
                    confirmed: true,
                  });
                  setAssigned([
                    ...assigned,
                    { skillId: detail.entry.id, revision: detail.entry.current_revision },
                  ]);
                  setNotice("Enabled for future sessions in this scope.");
                } else {
                  await call("skill.remove", { id: detail.entry.id, confirmed: true });
                  setDetail(undefined);
                  await refresh();
                  setNotice("Removed from library. Session versions are retained.");
                }
                setConfirmation(undefined);
              })
            }
          >
            {confirmation === "enable" ? "Enable skill" : "Remove from library"}
          </Button>
        </div>
      </dialog>
    </section>
  );
}

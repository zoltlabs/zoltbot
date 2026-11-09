import { useEffect, useState } from "react";
import { Button, Dialog, Field, Select, Textarea } from "../components/primitives.js";
import { useShell } from "../state.js";
import { errorText, type QuickConnectionProp } from "./data.js";

/**
 * "Continue in workspace": creates a normal workspace chat with a chosen profile and puts a
 * reviewable brief in its composer. Nothing runs until the person sends it there.
 */
export function Handoff({
  connection,
  chatId,
  onClose,
}: {
  connection: QuickConnectionProp;
  chatId: string;
  onClose(): void;
}) {
  const entities = connection.snapshot.entities;
  const projects = (entities.project ?? []).filter((row) => !row.archived);
  const profiles = (entities.agent ?? []).filter((row) => !row.archived && !row.hidden);
  const [brief, setBrief] = useState("");
  const [projectId, setProjectId] = useState(String(projects[0]?.id ?? ""));
  const [teamId, setTeamId] = useState("");
  const [profileId, setProfileId] = useState(String(profiles[0]?.id ?? ""));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void connection.call("quickChat.handoffPreview", { id: chatId }).then(
      (result) => setBrief((result as { brief: string }).brief),
      (failure) => setError(errorText(failure)),
    );
  }, [chatId, connection.call]);
  const teams = (entities.subproject ?? []).filter(
    (row) => row.projectId === projectId && !row.archived,
  );
  const submit = async () => {
    setBusy(true);
    try {
      const result = (await connection.call(
        "quickChat.handoff",
        {
          id: chatId,
          projectId,
          ...(teamId ? { subprojectId: teamId } : {}),
          profileId,
          brief,
          confirmed: true,
        },
        `quick-handoff-${crypto.randomUUID()}`,
      )) as { threadId: string; brief: string };
      useShell.setState({ chatDraft: { threadId: result.threadId, text: result.brief } });
      onClose();
      useShell.getState().openThread(result.threadId);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title="Continue in workspace"
      description="Creates a normal chat in the workspace with the profile you choose. The brief waits in its composer for you to review and send. The profile's usual permissions apply; nothing starts until you send."
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={busy || !projectId || !profileId || !brief.trim()}
            onClick={() => void submit()}
          >
            Create workspace chat
          </Button>
        </>
      }
    >
      {error ? <p role="alert">{error}</p> : null}
      {projects.length && profiles.length ? (
        <div className="quick-handoff-fields">
          <Field label="Workspace">
            <Select
              value={projectId}
              onChange={(event) => {
                setProjectId(event.target.value);
                setTeamId("");
              }}
            >
              {projects.map((row) => (
                <option key={String(row.id)} value={String(row.id)}>
                  {String(row.name)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Team">
            <Select value={teamId} onChange={(event) => setTeamId(event.target.value)}>
              <option value="">Whole workspace</option>
              {teams.map((row) => (
                <option key={String(row.id)} value={String(row.id)}>
                  {String(row.name)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Profile">
            <Select value={profileId} onChange={(event) => setProfileId(event.target.value)}>
              {profiles.map((row) => (
                <option key={String(row.id)} value={String(row.id)}>
                  {String(row.name)}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Brief"
            hint="Edit freely. Only this brief goes to the new chat, not the whole conversation."
          >
            <Textarea rows={10} value={brief} onChange={(event) => setBrief(event.target.value)} />
          </Field>
        </div>
      ) : (
        <p>Create a workspace and a profile first, then continue here.</p>
      )}
    </Dialog>
  );
}

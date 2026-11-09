import type {
  SkillEntryView as SkillEntry,
  SkillSnapshotView as SkillSnapshot,
} from "@zoltbot/protocol";
import { useEffect, useState } from "react";
import type { ContextSectionProps } from "../context/SessionInputsPanel.js";
export function TaskSkillsContextSection({ connection, task, mode }: ContextSectionProps) {
  const [data, setData] = useState<{ snapshot: SkillSnapshot | null; current: SkillEntry[] }>(),
    [error, setError] = useState(false);
  const profileId = task.ownerAgentId,
    scope = JSON.stringify(task.node);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh frozen inputs when daemon events change.
  useEffect(() => {
    let active = true;
    if (mode === "preview" && (!profileId || !scope)) {
      setData({ snapshot: null, current: [] });
      setError(false);
      return;
    }
    void connection
      .call("skill.context", {
        taskId: task.id,
        ...(mode === "preview"
          ? { preview: true, profileId, scope: JSON.parse(scope ?? "null") }
          : {}),
      })
      .then((result) => {
        if (active) {
          setData(result as typeof data);
          setError(false);
        }
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [connection.call, task.id, connection.snapshot.seq, mode, profileId, scope]);
  if (error) return <output>Skill inputs could not be read. Reconnect to try again.</output>;
  if (!data) return <p aria-live="polite">Loading skill inputs…</p>;
  if (!data.snapshot)
    return (
      <p className="dim">
        {mode === "preview"
          ? "Preview is checked again at start."
          : "No managed skills recorded at start."}
      </p>
    );
  return (
    <>
      <p className="dim sm">
        {mode === "preview"
          ? "Selected for launch · Preview checked again at start"
          : "Used by this session · Since start"}
      </p>
      <ul>
        {data.snapshot.skills.map((skill) => (
          <li key={skill.skillId}>
            <strong>
              {skill.name} · v{skill.revision}
            </strong>
            <p>
              Enabled ✓ · Installed {skill.installedPath ? "✓" : "Not reported"} · Reported loaded{" "}
              {skill.reportedLoaded === true ? "✓" : "Not reported"}
            </p>
            {(data.current.find((entry) => entry.id === skill.skillId)?.current_revision ??
              skill.revision) > skill.revision && (
              <output>A newer version is available for new sessions.</output>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

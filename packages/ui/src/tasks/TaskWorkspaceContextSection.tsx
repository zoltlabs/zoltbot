import { text } from "../chat/types.js";
import { registerContextSection } from "../context/SessionInputsPanel.js";

registerContextSection({
  id: "00-workspace",
  title: "Workspace",
  render: ({ connection, task }) => {
    const workspace = connection.snapshot.entities.workspace?.find(
      (row) => row.id === task.workspaceId,
    );
    const project = connection.snapshot.entities.project?.find((row) => row.id === task.projectId);
    const roots = (project?.roots ?? []) as { path: string }[];
    return (
      <div>
        <p>{task.workspaceMode === "worktree" ? "Separate worktree" : "Shared folder"}</p>
        {workspace?.repoRoot ? (
          <p>
            Repository <code>{text(workspace.repoRoot)}</code>
          </p>
        ) : roots.length === 1 ? (
          <p>
            Repository <code>{roots[0]?.path}</code>
          </p>
        ) : null}
        {!workspace && task.workspaceMode === "worktree" ? (
          <p>
            Base <code>{text(task.baseRef) || "HEAD"}</code> · commit and managed location resolve
            before start.
          </p>
        ) : null}
        {workspace ? (
          <>
            <p>
              <code>{text(workspace.path)}</code>
            </p>
            <p>
              Base <code>{text(workspace.baseRef)}</code>
            </p>
          </>
        ) : null}
        <p className="dim sm">Work location stays fixed when this conversation resumes.</p>
      </div>
    );
  },
});
